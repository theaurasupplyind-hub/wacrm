// Glosario de términos de pedido (aprendido). Cuando el bot no entiende una
// forma de nombrar un producto, pregunta y guarda el significado; en pedidos
// futuros lo aplica solo (grosor o alias de texto).
//
// La clasificación/vocabulario vive en `classify-item.ts`; acá queda la
// interpretación del término, su aplicación al texto y la persistencia.

import type { SupabaseClient } from '@supabase/supabase-js'
import { callOpenRouter } from '@/lib/ai/openrouter'
import { normalizeText } from '@/lib/precios'
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

/** Normaliza un término para comparar (minúsculas, sin acentos, espacios simples). */
export function normalizeTerm(term: string): string {
  return normalizeText(term)
    .replace(/[^a-z0-9áéíóúñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
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
  return items.map(it => ({ ...it, texto: applyOrderGlossaryText(it.texto, glossary) }))
}

// ── Detección de intención de glosario en el mensaje ──

// "revisá el glosario", "mira el glosario", "usa el glosario", "repasá el glosario".
const REVIEW_RE = /\b(?:revis|mir|chequ|repas|us|aplic|ver)[^\s]{0,4}\s+(?:el\s+|mi\s+|tu\s+|nuestro\s+)?glosario\b/i

// Verbos de definición: "moldura significa grosor", "X quiere decir Y", "X = Y".
const DEF_VERB = '(?:significa|significan|quiere decir|quieren decir|se llama|se llaman|se dice|se dicen|se refiere a|refiere a|ser[íi]a|ser[íi]an|=)'

/** ¿El usuario pide revisar/reprocesar con el glosario? */
export function wantsGlossaryReview(text: string): boolean {
  return REVIEW_RE.test(text || '')
}

/** Quita la frase "revisá el glosario" del mensaje. */
export function stripGlossaryReview(text: string): string {
  return (text || '').replace(new RegExp(REVIEW_RE.source, 'gi'), ' ').replace(/\s+/g, ' ').trim()
}

export interface InlineDefinition {
  /** Término definido (a la izquierda del verbo). */
  term: string
  /** Lo que significa (a la derecha). */
  meaning: string
  /** El mensaje sin la definición (por si además trae un pedido). */
  cleaned: string
}

/**
 * Detecta una definición "en línea" del tipo `moldura significa grosor` o
 * `tapiz = marco con tela`, para aprenderla sin pasar por la pregunta.
 */
export function detectInlineDefinition(text: string): InlineDefinition | null {
  const base = stripGlossaryReview(text)
  if (!base) return null
  const re = new RegExp(`([^,;:]{2,40}?)\\s*${DEF_VERB}\\s*([^,;:]{2,40})`, 'i')
  const m = base.match(re)
  if (!m || m.index === undefined) return null
  const term = m[1].replace(/^\s*(?:y|que|el|la|los|las)\s+/i, '').trim()
  if (!term || /\d/.test(term) || term.split(/\s+/).length > 3) return null
  const meaning = m[2].trim()
  const cleaned = (base.slice(0, m.index) + ' ' + base.slice(m.index + m[0].length))
    .replace(/\s+/g, ' ')
    .trim()
  return { term, meaning, cleaned }
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
