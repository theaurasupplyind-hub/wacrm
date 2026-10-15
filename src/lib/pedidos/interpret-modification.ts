/**
 * Modificación de una línea de la cotización abierta ("a la pintura 135x190
 * descuentale 10%", "sacá la línea 2", "la línea 1 ponela x3").
 *
 * El LLM solo RESUELVE a qué línea apuntan ("pintura 135x190" → línea 3) y qué
 * operación piden. La ARITMÉTICA es determinística en `applyQuoteModification`
 * (nunca el modelo calcula precios). Ante cualquier duda o fallo → null y el
 * flujo sigue por el camino actual (re-cotizar).
 * Sin side effects: solo interpreta + calcula en memoria.
 */
import { callOpenRouter } from '@/lib/ai/openrouter'
import type { PedidoItem } from './types'

export interface QuoteLine {
  /** Número visible en el chat (1-based sobre cotizables). */
  n: number
  descripcion: string
  cantidad: number
  precio: number | null
}

export type ModificationOp = 'discount_percent' | 'remove' | 'set_quantity'

export interface QuoteModification {
  /** Línea 1-based tal como se muestra en el chat. */
  line: number
  op: ModificationOp
  /** % (1-99), cantidad (1-999). Sin uso en 'remove'. */
  value: number
}

const MODIFICATION_PROMPT = `Sos el intérprete de modificaciones a una cotización abierta en un taller de marcos. El usuario ve líneas numeradas y pide cambiar UNA. Devolvé EXCLUSIVAMENTE un JSON: {"line": number, "op": "discount_percent" | "remove" | "set_quantity", "value": number} o null si NO es claramente una de estas operaciones.

- "discount_percent": le baja el precio a una línea ("a la pintura 135x190 descuentale 10%", "haceme 15% en la línea 2", "al bastidor grande rebajale 5 mil" → NO: monto fijo no es porcentaje → null). value = el % (1-99).
- "remove": saca una línea ("sacá la línea 2", "quitá la pintura", "el tapacanto no va"). value = 0.
- "set_quantity": cambia cantidad de una línea ("la línea 1 ponela x3", "que sean 2 del bastidor chico"). value = cantidad (1-99).
- "line": el número de la línea TAL COMO SE MUESTRA. Si nombra el producto ("la pintura 135x190"), mapealo al número correspondiente. Si es ambiguo (dos líneas iguales y no aclara cuál) → null.
- CUALQUIER otra cosa (cambiar medida/variante, agregar ítems, "son pinturas", preguntas, confirmaciones) → null. Eso lo maneja otro flujo.
DEVOLVÉ SOLO EL JSON O null.`

function norm(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
}

/**
 * Fast path sin LLM: referencia explícita "línea/item N".
 * Devuelve null si no hay match (el LLM intenta con nombres de producto).
 */
export function fastQuoteModification(text: string): QuoteModification | null {
  const t = norm(text)
  const lineRef = t.match(/(?:linea|item)\s+(\d{1,2})/)
  if (!lineRef) return null
  const line = parseInt(lineRef[1], 10)
  if (!Number.isFinite(line) || line < 1) return null

  const pct = t.match(/(\d+(?:[.,]\d+)?)\s*%/)
  if (pct && !/aument|increment|sub[ii]|recarg|interes/i.test(t)) {
    // "X% en la línea N" ante cotización abierta es un descuento (el % solo
    // aparece para eso; subir precios no es una operación ofrecida).
    const value = Math.round(parseFloat(pct[1].replace(',', '.')))
    if (value >= 1 && value <= 99) return { line, op: 'discount_percent', value }
    return null
  }
  if (/\bsac[ao]|quit[ao]|elimin[ao]|borr[ao]|no va|afuera\b/.test(t)) {
    return { line, op: 'remove', value: 0 }
  }
  const qty = t.match(/(?:x\s*(\d{1,3})|cantidad\s*(\d{1,3})|(?:ponela|ponelo|dejala|dejalo|sean|que sean)\s*(\d{1,3}))/i)
  const q = qty ? parseInt(qty[1] ?? qty[2] ?? qty[3], 10) : NaN
  if (Number.isFinite(q) && q >= 1 && q <= 99) return { line, op: 'set_quantity', value: q }
  return null
}

function validModification(raw: unknown): QuoteModification | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as { line?: unknown; op?: unknown; value?: unknown }
  const line = typeof o.line === 'number' ? o.line : Number(o.line)
  if (!Number.isInteger(line) || line < 1 || line > 99) return null
  if (o.op !== 'discount_percent' && o.op !== 'remove' && o.op !== 'set_quantity') return null
  const value = typeof o.value === 'number' ? o.value : Number(o.value)
  if (o.op === 'remove') return { line, op: 'remove', value: 0 }
  if (!Number.isFinite(value)) return null
  if (o.op === 'discount_percent' && (value < 1 || value > 99)) return null
  if (o.op === 'set_quantity' && (!Number.isInteger(value) || value < 1 || value > 99)) return null
  return { line, op: o.op, value: Math.round(value) }
}

export async function interpretQuoteModification(
  text: string,
  lines: QuoteLine[],
): Promise<QuoteModification | null> {
  if (!text || !text.trim() || lines.length === 0) return null
  const fast = fastQuoteModification(text)
  if (fast) return fast.line <= lines.length ? fast : null
  try {
    const linesText = lines
      .map((l) => `${l.n}. ${l.cantidad > 1 ? `${l.cantidad}x ` : ''}${l.descripcion} — $${(l.precio ?? 0).toLocaleString('es-AR')}`)
      .join('\n')
    const res = await callOpenRouter({
      systemPrompt: MODIFICATION_PROMPT,
      userMessage: `Líneas de la cotización:\n${linesText}\n\nMensaje del usuario: "${text}"`,
      jsonMode: true,
      temperature: 0,
      maxTokens: 150,
      model: process.env.EXTRACTOR_MODEL || undefined,
    })
    const block = res.text.match(/\{[\s\S]*\}/)
    if (!block) return null
    const mod = validModification(JSON.parse(block[0]))
    if (!mod || mod.line > lines.length) return null
    return mod
  } catch (err) {
    console.error('[interpret-modification] LLM falló, se re-cotiza:', err instanceof Error ? err.message : String(err))
    return null
  }
}

/** Redondeo de catálogo (múltiplo de 1000, como las reglas de pricing). */
export function roundCatalogPrice(n: number): number {
  return Math.round(n / 1000) * 1000
}

function money(n: number): string {
  return `$${n.toLocaleString('es-AR')}`
}

export type ApplyResult = { items: PedidoItem[]; note: string } | { error: string }

/**
 * Aplica la modificación sobre los ítems (orden original, incluye faltantes
 * que no se tocan). Las líneas se cuentan como en el chat: solo cotizables.
 */
export function applyQuoteModification(items: PedidoItem[], mod: QuoteModification): ApplyResult {
  const cotizables = items.filter((it) => !it.faltante)
  const target = cotizables[mod.line - 1]
  if (!target) return { error: 'Esa línea no existe en la cotización. Decime el número tal como aparece arriba.' }
  if (target.precio_unitario == null) {
    return { error: `La línea ${mod.line} (${target.descripcion}) está sin precio, no puedo calcular. La vemos a mano.` }
  }
  if (target.aRevisar) {
    return { error: `La línea ${mod.line} está marcada a revisar, prefiero no tocarla hasta confirmar su precio.` }
  }

  if (mod.op === 'remove') {
    if (cotizables.length <= 1) return { error: 'No puedo dejar la cotización sin líneas. Si no va nada, la cancelamos.' }
    const next = items.filter((it) => it !== target)
    return { items: next, note: `Saqué la línea ${mod.line} (${target.descripcion}).` }
  }

  if (mod.op === 'set_quantity') {
    const next = items.map((it) =>
      it === target ? { ...it, cantidad: mod.value } : it,
    )
    return { items: next, note: `La línea ${mod.line} (${target.descripcion}) quedó x${mod.value}.` }
  }

  // discount_percent
  const before = target.precio_unitario * target.cantidad
  const newUnit = roundCatalogPrice(target.precio_unitario * (1 - mod.value / 100))
  if (newUnit <= 0) return { error: 'Ese descuento deja la línea en $0. Revisemos el número.' }
  const next = items.map((it) =>
    it === target ? { ...it, precio_unitario: newUnit } : it,
  )
  const after = newUnit * target.cantidad
  const cant = target.cantidad > 1 ? ` (x${target.cantidad})` : ''
  return {
    items: next,
    note: `Apliqué ${mod.value}% a la línea ${mod.line} (${target.descripcion})${cant}: ${money(before)} → ${money(after)}.`,
  }
}
