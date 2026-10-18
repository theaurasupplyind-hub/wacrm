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

export interface BotVocabulary {
  refs: PrecioReferencia[]
  rules: PricingRule[]
  categorias: string[]
  variantes: string[]
  /** Palabras conocidas normalizadas (categorías + variantes + reglas/tokens). */
  knownWords: string[]
  /** Término normalizado → destino. Sinónimos aprendidos (se completa en Plan B). */
  sinonimos: Map<string, string>
  /** Categoría cuando no se reconoce ninguna. Hoy fijo: mover a dato en Plan A3. */
  categoriaDefault: string
}

export const DEFAULT_CATEGORIA = 'BASTIDOR'

/** El panel de precios/reglas cambia poco: 5 min alcanza y sobra. */
export const VOCABULARY_TTL_MS = 5 * 60 * 1000

interface CacheEntry {
  value: BotVocabulary
  at: number
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<BotVocabulary>>()

/** Arma el vocabulario desde el catálogo. Puro (sin red) — apto para tests. */
export function buildVocabulary(refs: PrecioReferencia[], rules: PricingRule[]): BotVocabulary {
  const categorias = [...new Set(refs.map((r) => r.categoria))].filter(Boolean)
  const variantes = [...new Set(refs.map((r) => r.variante))].filter(Boolean)
  const knownWords = buildKnownVocab(refs, rules).knownWords
  return {
    refs,
    rules,
    categorias,
    variantes,
    knownWords,
    sinonimos: new Map(),
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
export async function getVocabulary(accountId: string): Promise<BotVocabulary> {
  const hit = cache.get(accountId)
  if (hit && Date.now() - hit.at < VOCABULARY_TTL_MS) return hit.value

  const pending = inflight.get(accountId)
  if (pending) return pending

  const load = (async () => {
    try {
      const [refs, rules] = await Promise.all([getPreciosReferencia(), getPricingRules()])
      const value = buildVocabulary(refs, rules)
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
  const product = [...vocab.categorias, ...vocab.variantes, ...vocab.sinonimos.keys()]
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

function ruleLabel(r: PricingRule): string {
  if (r.operation === 'percentage' && r.operationValue) {
    return `${r.name} (${r.operationValue > 0 ? '+' : ''}${r.operationValue}%)`
  }
  if (r.operation === 'fixed' && r.operationValue) return `${r.name} ($${r.operationValue})`
  return r.name
}

/**
 * Bloque compacto con el catálogo actual, para inyectar en los prompts de los
 * LLM en vez de listas de producto hardcodeadas. Sin vocabulario devuelve una
 * instrucción genérica (no rompe llamadores sin cuenta).
 */
export function buildVocabularyPromptBlock(vocab: BotVocabulary | null | undefined): string {
  if (!vocab) {
    return 'CATÁLOGO: usá los nombres de producto/variante tal como los escribe el cliente; no los traduzcas ni los reemplaces.'
  }
  const lines = [
    'CATÁLOGO ACTUAL (nombres que el sistema reconoce; usalos tal cual los escribe el cliente):',
    `- Categorías/productos: ${vocab.categorias.join(' | ') || '(sin datos)'}`,
    `- Variantes: ${vocab.variantes.join(' | ') || '(sin datos)'}`,
    `- Reglas de precio: ${vocab.rules.map(ruleLabel).join(' | ') || '(sin datos)'}`,
  ]
  if (vocab.sinonimos.size > 0) {
    const pares = [...vocab.sinonimos.entries()].map(([term, dest]) => `${term} = ${dest}`)
    lines.push(`- Términos ya aprendidos: ${pares.join(' | ')}`)
  }
  return lines.join('\n')
}
