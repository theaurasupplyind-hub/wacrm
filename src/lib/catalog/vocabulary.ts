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
import type { PrecioReferencia, PricingRule } from '@/lib/precios'
import { buildKnownVocab } from '@/lib/pedidos/classify-item'

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
