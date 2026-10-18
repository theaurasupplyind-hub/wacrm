/**
 * P0 — Proveedor de vocabulario del bot.
 *
 * Una sola fuente para los gates de clasificación, los prompts del LLM y la
 * construcción de descripciones: categorías, variantes, reglas y palabras
 * conocidas, derivadas de `precios_referencia` + `pricing_rules` (Plan A).
 *
 * Cachea el catálogo por cuenta (TTL corto) para no pegar 2 HTTP por request.
 * Los sinónimos aprendidos (glosario) se suman acá en el Plan B.
 *
 * Ver `plan-01-vocabulario-datos.md`.
 */
import { getPreciosReferencia, getPricingRules } from '@/lib/facbal/client'
import { normalizeText, type PrecioReferencia, type PricingRule } from '@/lib/precios'
import { buildKnownVocab, tokenMatchesWord } from '@/lib/pedidos/classify-item'
import { loadGlossary, type OrderGlossaryEntry } from '@/lib/pedidos/glossary'
import type { SupabaseClient } from '@supabase/supabase-js'
import { DEFAULT_CATEGORIA } from './defaults'

export { DEFAULT_CATEGORIA }

export interface BotVocabulary {
  refs: PrecioReferencia[]
  rules: PricingRule[]
  categorias: string[]
  variantes: string[]
  /** Palabras conocidas normalizadas (categorías + variantes + reglas/tokens). */
  knownWords: string[]
  /** Término normalizado → destino. Sinónimos aprendidos (Plan B). */
  sinonimos: Map<string, string>
  /** Nombres de productos FUERA de catálogo ya aprendidos (Plan B2). */
  productosAprendidos: string[]
  /** Categoría cuando no se reconoce ninguna (ver `catalog/defaults.ts`). */
  categoriaDefault: string
}

/** El panel de precios/reglas cambia poco: 5 min alcanza y sobra. */
export const VOCABULARY_TTL_MS = 5 * 60 * 1000

interface CacheEntry {
  value: BotVocabulary
  at: number
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<BotVocabulary>>()

/** Arma el vocabulario desde el catálogo. Puro (sin red) — apto para tests. */
export function buildVocabulary(
  refs: PrecioReferencia[],
  rules: PricingRule[],
  glossary: OrderGlossaryEntry[] = [],
): BotVocabulary {
  const categorias = [...new Set(refs.map((r) => r.categoria))].filter(Boolean)
  const variantes = [...new Set(refs.map((r) => r.variante))].filter(Boolean)
  const knownWords = buildKnownVocab(refs, rules).knownWords
  // Plan B: lo aprendido entra al vocabulario (sinónimos + productos fuera de catálogo).
  const sinonimos = new Map<string, string>()
  const productosAprendidos: string[] = []
  for (const g of glossary) {
    if (g.meaning.type === 'alias') {
      const dest = 'target' in g.meaning ? g.meaning.target : g.meaning.value
      if (dest) sinonimos.set(g.termNorm, dest)
    } else if (g.meaning.type === 'producto') {
      productosAprendidos.push(g.meaning.value)
    }
  }
  return {
    refs,
    rules,
    categorias,
    variantes,
    knownWords,
    sinonimos,
    productosAprendidos,
    categoriaDefault: DEFAULT_CATEGORIA,
  }
}

/** Invalida la cache. Llamar tras editar el glosario o el catálogo. */
export function invalidateVocabulary(accountId?: string): void {
  if (accountId) {
    cache.delete(accountId)
    inflight.delete(accountId)
    return
  }
  cache.clear()
  inflight.clear()
}

/**
 * Vocabulario de la cuenta (cacheado). Deduplica pedidos concurrentes y, ante
 * error de red, devuelve la última copia buena en vez de romper el turno.
 */
export async function getVocabulary(accountId: string, db?: SupabaseClient): Promise<BotVocabulary> {
  const hit = cache.get(accountId)
  if (hit && Date.now() - hit.at < VOCABULARY_TTL_MS) return hit.value

  const pending = inflight.get(accountId)
  if (pending) return pending

  const load = (async () => {
    try {
      const [refs, rules, glossary] = await Promise.all([
        getPreciosReferencia(),
        getPricingRules(),
        db ? loadGlossary(db, accountId) : Promise.resolve([] as OrderGlossaryEntry[]),
      ])
      const value = buildVocabulary(refs, rules, glossary)
      cache.set(accountId, { value, at: Date.now() })
      return value
    } catch (err) {
      console.warn('[vocabulary] load failed:', err instanceof Error ? err.message : String(err))
      if (hit) return hit.value
      throw err
    } finally {
      inflight.delete(accountId)
    }
  })()

  inflight.set(accountId, load)
  return load
}

/** Solo para tests: limpia la cache. */
export function __resetVocabularyCache(): void {
  cache.clear()
  inflight.clear()
}

// ── Predicados de vocabulario (gates de clasificación) ──────────────────────

/** Palabras significativas de un término (sin artículos ni unidades/medidas). */
function phraseWords(text: string): string[] {
  return normalizeText(String(text))
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !/\d/.test(w))
}

function anyTokenMatches(words: string[], target: string): boolean {
  return words.some((w) => tokenMatchesWord(w, target))
}

function matchesAnyPhrase(textWords: string[], phrases: string[][]): boolean {
  return phrases.some((parts) => parts.length > 0 && parts.every((p) => anyTokenMatches(textWords, p)))
}

interface VocabPhrases {
  /** Categorías, variantes y sinónimos de producto. Sin reglas (incluyen insumos). */
  product: string[][]
  /** Todo: producto + nombres y tokens de reglas. */
  catalog: string[][]
}

const PHRASE_CACHE = new WeakMap<BotVocabulary, VocabPhrases>()

function vocabPhrases(vocab: BotVocabulary): VocabPhrases {
  const cached = PHRASE_CACHE.get(vocab)
  if (cached) return cached
  const product = [
    ...vocab.categorias,
    ...vocab.variantes,
    ...vocab.sinonimos.keys(),
    ...vocab.productosAprendidos,
  ]
    .map(phraseWords)
    .filter((p) => p.length > 0)
  const rules = [...vocab.rules.map((r) => r.name), ...vocab.rules.flatMap((r) => r.matchTokens)]
    .map(phraseWords)
    .filter((p) => p.length > 0)
  const value: VocabPhrases = { product, catalog: [...product, ...rules] }
  PHRASE_CACHE.set(vocab, value)
  return value
}

function mentions(text: string, phrases: string[][]): boolean {
  const words = phraseWords(text)
  if (words.length === 0) return false
  return matchesAnyPhrase(words, phrases)
}

/**
 * ¿El texto menciona un **producto** del catálogo (categoría, variante o
 * sinónimo)? Excluye reglas a propósito: los nombres de reglas incluyen insumos
 * ("Pinturas", "Impresion") que en un gasto NO son un pedido.
 */
export function mentionsProduct(text: string, vocab: BotVocabulary): boolean {
  return mentions(text, vocabPhrases(vocab).product)
}

/** ¿El texto menciona cualquier término del catálogo (producto o regla)? */
export function mentionsCatalogTerm(text: string, vocab: BotVocabulary): boolean {
  return mentions(text, vocabPhrases(vocab).catalog)
}

// ── Bloque de vocabulario para los prompts del LLM (Plan A2) ────────────────

function ruleLabel(r: PricingRule, withAdjustments: boolean): string {
  if (!withAdjustments) return r.name
  if (r.operation === 'percentage' && r.operationValue) {
    return `${r.name} (${r.operationValue > 0 ? '+' : ''}${r.operationValue}%)`
  }
  if (r.operation === 'fixed' && r.operationValue) return `${r.name} ($${r.operationValue})`
  return r.name
}

export interface VocabularyPromptOptions {
  /** Incluye "Categorías/productos". */
  products?: boolean
  /** Incluye "Variantes". */
  variants?: boolean
  /** Incluye "Reglas de precio". */
  rules?: boolean
  /** Incluye el ajuste de precio en las reglas: "Pinturas (+10%)" vs "Pinturas". */
  ruleAdjustments?: boolean
}

const ALL_SECTIONS: Required<VocabularyPromptOptions> = {
  products: true,
  variants: true,
  rules: true,
  ruleAdjustments: true,
}

/**
 * Bloque compacto con el catálogo actual, para inyectar en los prompts de los
 * LLM en vez de listas de producto hardcodeadas. Se puede trimear por consumidor
 * (el extractor no necesita los ajustes de precio; el intérprete de cambios, las
 * reglas). Sin vocabulario devuelve una instrucción genérica (llamadores sin cuenta).
 *
 * NO incluye los términos aprendidos del glosario: esos se aplican de forma
 * determinística al texto antes de clasificar (`applyOrderGlossary`).
 */
export function buildVocabularyPromptBlock(
  vocab: BotVocabulary | null | undefined,
  opts: VocabularyPromptOptions = ALL_SECTIONS,
): string {
  if (!vocab) {
    return 'CATÁLOGO: usá los nombres de producto/variante tal como los escribe el cliente; no los traduzcas ni los reemplaces.'
  }
  const o = { ...ALL_SECTIONS, ...opts }
  const lines = [
    'CATÁLOGO ACTUAL (nombres que el sistema reconoce; usalos tal cual los escribe el cliente):',
  ]
  if (o.products) lines.push(`- Categorías/productos: ${vocab.categorias.join(' | ') || '(sin datos)'}`)
  if (o.variants) lines.push(`- Variantes: ${vocab.variantes.join(' | ') || '(sin datos)'}`)
  if (o.rules) {
    const rules = vocab.rules.map((r) => ruleLabel(r, o.ruleAdjustments)).join(' | ')
    lines.push(`- Reglas de precio: ${rules || '(sin datos)'}`)
  }
  // Plan B2: los productos FUERA de catálogo ya aprendidos SÍ van al prompt
  // (a diferencia de los sinónimos, que se sustituyen antes de clasificar): el
  // LLM tiene que reconocerlos como ítem de pedido.
  if (o.products && vocab.productosAprendidos.length > 0) {
    lines.push(`- Productos fuera de catálogo ya usados: ${vocab.productosAprendidos.join(' | ')}`)
  }
  return lines.join('\n')
}
