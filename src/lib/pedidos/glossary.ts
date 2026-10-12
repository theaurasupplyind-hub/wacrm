// Glosario de términos de pedido (aprendido). Cuando el bot no entiende una
// forma de nombrar un producto, pregunta y guarda el significado; en pedidos
// futuros lo aplica solo (grosor o alias de texto).

import type { SupabaseClient } from '@supabase/supabase-js'
import { callOpenRouter } from '@/lib/ai/openrouter'
import { normalizeText, singularize } from '@/lib/precios'
import type { PrecioReferencia, PricingRule } from '@/lib/precios'
import type { ParsedOrderItem } from './types'

export type GlossaryMeaning =
  | { type: 'grosor'; value: number }
  | { type: 'alias'; value: string }

export interface OrderGlossaryEntry {
  termNorm: string
  termDisplay: string
  meaning: GlossaryMeaning
}

export interface UnknownTerm {
  term: string
  itemIndex: number
}

/** Normaliza un término para comparar (minúsculas, sin acentos, espacios simples). */
export function normalizeTerm(term: string): string {
  return normalizeText(term)
    .replace(/[^a-z0-9áéíóúñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Palabras funcionales/genéricas que NO son términos a aclarar.
const STOPWORDS = new Set([
  'de', 'del', 'con', 'sin', 'para', 'y', 'e', 'a', 'el', 'la', 'los', 'las',
  'un', 'una', 'unos', 'unas', 'en', 'por', 'cm', 'mm', 'mts', 'm', 'grosor',
  'medida', 'tela', 'cuerpo', 'tipo', 'mas', 'menos', 'color', 'aprox',
])

const STOPWORDS_SING = new Set([...STOPWORDS].map(w => singularize(w)))

/** Vocabulario conocido: categorías, variantes y reglas (más sus tokens). */
export function buildKnownVocab(refs: PrecioReferencia[], rules: PricingRule[]): Set<string> {
  const vocab = new Set<string>()
  const add = (s: string) => {
    for (const w of normalizeTerm(s).split(/\s+/)) {
      if (!w) continue
      vocab.add(w)
      vocab.add(singularize(w))
    }
  }
  for (const r of refs) {
    add(r.categoria)
    add(r.variante)
  }
  for (const rule of rules) {
    add(rule.name)
    for (const t of rule.matchTokens) add(t)
  }
  return vocab
}

/**
 * Detecta palabras del pedido que no pertenecen al vocabulario conocido ni al
 * glosario (candidatas a preguntar). Ignora medidas/números y palabras vacías.
 */
export function detectUnknownTerms(
  items: ParsedOrderItem[],
  vocab: Set<string>,
  glossary: OrderGlossaryEntry[] = [],
): UnknownTerm[] {
  const known = new Set(vocab)
  for (const g of glossary) {
    known.add(g.termNorm)
    for (const w of g.termNorm.split(/\s+/)) known.add(w)
  }

  const out: UnknownTerm[] = []
  const seen = new Set<string>()
  items.forEach((it, itemIndex) => {
    for (const w of normalizeTerm(it.texto).split(/\s+/)) {
      if (!w || /\d/.test(w)) continue
      if (w.length < 3) continue
      if (STOPWORDS.has(w) || STOPWORDS_SING.has(singularize(w))) continue
      const sing = singularize(w)
      if (known.has(w) || known.has(sing)) continue
      if (seen.has(w)) continue
      seen.add(w)
      out.push({ term: w, itemIndex })
    }
  })
  return out
}

// ── Aplicación del glosario al texto del pedido ──

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Vuelve un término flexible a acentos ("info" matchea "infó"). */
function accentFlexible(term: string): string {
  const map: Record<string, string> = { a: '[aá]', e: '[eé]', i: '[ií]', o: '[oó]', u: '[uú]', n: '[nñ]' }
  return term.split('').map(c => map[c] ?? escapeRegExp(c)).join('')
}

/** Convierte la primera medida doble "AxB" en triple "AxBxG". */
function applyGrosorToText(text: string, grosor: number): string {
  const re = /(\d+(?:[.,]\d+)?)\s*[xX×*]\s*(\d+(?:[.,]\d+)?)(?:\s*[xX×*]\s*(\d+(?:[.,]\d+)?))?/
  const m = text.match(re)
  if (!m || m[3] !== undefined) return text
  return text.replace(re, `${m[1]}x${m[2]}x${grosor}`)
}

function builtInGrosor(text: string): number | null {
  const m =
    text.match(/grosor\s*(?:de\s+)?(\d+(?:[.,]\d+)?)/i) ||
    text.match(/(\d+(?:[.,]\d+)?)\s*(?:cm|centimetros|centímetros)?\s*de\s*grosor/i)
  if (!m) return null
  const n = parseFloat(m[1].replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Aplica glosario + expresiones explícitas de grosor a un texto de ítem. */
export function applyOrderGlossaryText(texto: string, glossary: OrderGlossaryEntry[]): string {
  let t = texto
  for (const g of glossary) {
    const re = new RegExp(
      `\\b${accentFlexible(g.termNorm)}\\b(?:\\s+de\\s+\\d+(?:[.,]\\d+)?|\\s+\\d+(?:[.,]\\d+)?)?`,
      'gi',
    )
    if (!re.test(t)) continue
    if (g.meaning.type === 'alias') {
      t = t.replace(re, ` ${g.meaning.value} `)
    } else {
      t = t.replace(re, ' ')
      t = applyGrosorToText(t, g.meaning.value)
    }
  }
  const g = builtInGrosor(t)
  if (g !== null) {
    t = t.replace(/grosor\s*(?:de\s+)?\d+(?:[.,]\d+)?/gi, ' ')
    t = t.replace(/\d+(?:[.,]\d+)?\s*(?:cm|centimetros|centímetros)?\s*de\s*grosor/gi, ' ')
    t = applyGrosorToText(t, g)
  }
  return t.replace(/\s+/g, ' ').trim()
}

export function applyOrderGlossary(
  items: ParsedOrderItem[],
  glossary: OrderGlossaryEntry[],
): ParsedOrderItem[] {
  if (glossary.length === 0) {
    return items.map(it => ({ ...it, texto: applyOrderGlossaryText(it.texto, []) }))
  }
  return items.map(it => ({ ...it, texto: applyOrderGlossaryText(it.texto, glossary) }))
}

// ── Persistencia ──

interface RawGlossaryRow {
  term_norm?: string
  term_display?: string
  meaning?: unknown
}

function parseMeaning(raw: unknown): GlossaryMeaning | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as { type?: unknown; value?: unknown }
  if (o.type === 'grosor') {
    const n = typeof o.value === 'number' ? o.value : parseFloat(String(o.value ?? '').replace(',', '.'))
    return Number.isFinite(n) && n > 0 ? { type: 'grosor', value: n } : null
  }
  if (o.type === 'alias' && typeof o.value === 'string' && o.value.trim()) {
    return { type: 'alias', value: o.value.trim().toLowerCase() }
  }
  return null
}

export async function loadGlossary(
  db: SupabaseClient,
  accountId: string,
): Promise<OrderGlossaryEntry[]> {
  try {
    const { data } = await db
      .from('order_glossary')
      .select('term_norm, term_display, meaning')
      .eq('account_id', accountId)
    if (!Array.isArray(data)) return []
    const out: OrderGlossaryEntry[] = []
    for (const row of data as RawGlossaryRow[]) {
      const meaning = parseMeaning(row.meaning)
      if (!row.term_norm || !meaning) continue
      out.push({ termNorm: row.term_norm, termDisplay: row.term_display || row.term_norm, meaning })
    }
    return out
  } catch (err) {
    console.error('[glossary] load error:', err)
    return []
  }
}

export async function upsertGlossary(
  db: SupabaseClient,
  accountId: string,
  entry: OrderGlossaryEntry,
  createdBy?: string | null,
): Promise<void> {
  try {
    await db.from('order_glossary').upsert(
      {
        account_id: accountId,
        term_norm: entry.termNorm,
        term_display: entry.termDisplay,
        meaning: entry.meaning,
        created_by: createdBy ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'account_id,term_norm' },
    )
  } catch (err) {
    console.error('[glossary] upsert error:', err)
  }
}

export async function deleteGlossary(
  db: SupabaseClient,
  accountId: string,
  termNorm: string,
): Promise<void> {
  try {
    await db.from('order_glossary').delete().eq('account_id', accountId).eq('term_norm', termNorm)
  } catch (err) {
    console.error('[glossary] delete error:', err)
  }
}

// ── Interpretación de la respuesta del usuario (LLM) ──

const GLOSSARY_PROMPT = `Sos un asistente de un taller de bastidores. El usuario usa una forma de nombrar un producto que el sistema no entiende y tenemos que registrar qué significa para pedidos futuros.

Devolvé EXCLUSIVAMENTE un JSON:
{
  "meanings": [
    { "term": "término en minúsculas", "type": "grosor" | "alias", "value": número (para grosor) o texto (para alias) }
  ]
}

- "grosor": cuando el término indica el grosor/espesor del bastidor. value = número entero en cm (ej: "es de 4 centímetros" → 4).
- "alias": cuando el término es otra forma de decir un producto/variante del catálogo. value = el texto canónico del catálogo (ej: "doble 4cm", "lienzo profesional", "sin tela", "tapacanto").
- Si no podés decidir, devolvé "meanings": [].

Ejemplos:
"moldura de 4, es grosor 4" → {"meanings":[{"term":"moldura","type":"grosor","value":4}]}
"moldura quiere decir doble 4cm" → {"meanings":[{"term":"moldura","type":"alias","value":"doble 4cm"}]}

DEVOLVÉ SOLO EL JSON.`

export interface GlossaryInterpretation {
  termNorm: string
  meaning: GlossaryMeaning
}

function buildCatalogHint(refs: PrecioReferencia[], rules: PricingRule[]): string {
  const cats = [...new Set(refs.map(r => r.categoria))]
  const vars = [...new Set(refs.filter(r => r.categoria.toUpperCase() === 'BASTIDOR').map(r => r.variante))]
  const ruleNames = rules.map(r => r.name)
  return `Categorías: ${cats.join(', ')}. Variantes BASTIDOR: ${vars.join(', ')}. Reglas: ${ruleNames.join(', ')}.`
}

export async function parseGlossaryMeanings(
  terms: string[],
  answer: string,
  catalog: { refs: PrecioReferencia[]; rules: PricingRule[] },
): Promise<GlossaryInterpretation[]> {
  const userMessage = `Término(s) a interpretar: ${terms.join(', ')}\nRespuesta del usuario: "${answer}"\nCatálogo/reglas de referencia: ${buildCatalogHint(catalog.refs, catalog.rules)}`
  try {
    const res = await callOpenRouter({
      systemPrompt: GLOSSARY_PROMPT,
      userMessage,
      jsonMode: true,
      temperature: 0,
      maxTokens: 400,
    })
    const block = res.text.match(/\{[\s\S]*\}/)
    const parsed = JSON.parse(block ? block[0] : res.text) as { meanings?: unknown }
    const raw = Array.isArray(parsed.meanings) ? parsed.meanings : []
    const wanted = new Set(terms.map(normalizeTerm))
    const out: GlossaryInterpretation[] = []
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue
      const o = item as { term?: unknown; type?: unknown; value?: unknown }
      const termNorm = normalizeTerm(String(o.term ?? ''))
      if (!termNorm || !wanted.has(termNorm)) continue
      const meaning = parseMeaning({ type: o.type, value: o.value })
      if (meaning) out.push({ termNorm, meaning })
    }
    return out
  } catch (err) {
    console.error('[glossary] interpret error:', err)
    return []
  }
}
