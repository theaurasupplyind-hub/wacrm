/**
 * Intérprete GENERAL de cambios sobre una cotización abierta.
 *
 * Reemplaza al intérprete de 3 operaciones como mecanismo extensible: el LLM
 * traduce el mensaje a OPERACIONES TIPADAS sobre las líneas visibles; la
 * aritmética es determinística en `applyQuoteChanges` (el modelo nunca calcula
 * precios). Ante duda o fallo devuelve `none` (no cambia nada) y el flujo sigue
 * por el camino actual (re-cotizar).
 *
 * Resultado:
 *  - `ops`         → cambios concretos a aplicar.
 *  - `unsupported` → el usuario pidió un cambio que no sabemos hacer: se
 *                    responde honesto (Fase 4) y la cotización queda igual.
 *  - `none`        → no es un cambio de línea (agregar ítems, cliente, entrega,
 *                    fecha, confirmar/cancelar, preguntas) → lo maneja otro flujo.
 *
 * Sin side effects: solo interpreta + calcula en memoria.
 */
import { callOpenRouter } from '@/lib/ai/openrouter'
import type { PedidoItem } from './types'
import { roundCatalogPrice } from './interpret-modification'

export interface QuoteLine {
  /** Número visible en el chat (1-based sobre cotizables). */
  n: number
  descripcion: string
  cantidad: number
  precio: number | null
}

export type ChangeOp =
  | {
      op: 'set_price'
      /** `'all'` aplica el cambio a todas las líneas. */
      line: number | 'all'
      mode: 'absolute' | 'percent'
      value: number
    }
  | { op: 'set_quantity'; line: number; value: number }
  | { op: 'remove'; line: number }

export type ChangeResult =
  | { kind: 'ops'; ops: ChangeOp[] }
  | { kind: 'unsupported'; motivo: string }
  | { kind: 'none' }

const NONE: ChangeResult = { kind: 'none' }

const CHANGE_PROMPT = `Sos el intérprete de cambios sobre una cotización abierta en un taller de marcos. El usuario ve líneas numeradas. Devolvé EXCLUSIVAMENTE un JSON con UNA de estas formas:
{"ops":[ ... ]} para aplicar cambios sobre las líneas,
{"unsupported":"motivo corto"} si el usuario pide un cambio sobre la cotización que NO podés resolver,
{"none":true} si NO es un cambio sobre las líneas de la cotización.

Operaciones válidas:
- {"op":"set_price","line":N|"all","mode":"absolute"|"percent","value":number}
- {"op":"set_quantity","line":N,"value":number}
- {"op":"remove","line":N}

Reglas:
- set_price "absolute": fija el precio unitario ("poné el bastidor en 300000", "a la pintura dejalo en 50000", "vale 250mil"). "300mil"=300000, "300k"=300000.
- set_price "percent": baja el precio un porcentaje ("descontale 10%", "hacele 15%", "bajale 5% a todo"). value 1-99.
- set_quantity: cambia cantidad ("la línea 1 ponela x3", "que sean 2 del chico"). value 1-99.
- remove: saca una línea ("sacá la 2", "quitá el tapacanto", "el rollo no va").
- "line": número TAL COMO SE MUESTRA. Si nombra el producto/medida ("la pintura 135x190", "el bastidor de 142 x 195") mapealo a su número.
- Si dos líneas son iguales y no aclara cuál → {"unsupported":"no sé a qué línea"}.
- Agregar ítems, cambiar medida/variante, cliente, entrega, fecha o descuento general, confirmar o cancelar → {"none":true}.
DEVOLVÉ SOLO EL JSON.`

function norm(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
}

/**
 * Fast path sin LLM: referencia explícita "línea/item N" con % / quitar /
 * cantidad. Devuelve `null` si no matchea (el LLM intenta por nombre de producto).
 */
export function fastQuoteChanges(text: string): ChangeResult | null {
  const t = norm(text)
  const lineRef = t.match(/(?:linea|item)\s+(\d{1,2})/)
  if (!lineRef) return null
  const line = parseInt(lineRef[1], 10)
  if (!Number.isFinite(line) || line < 1) return null

  const pct = t.match(/(\d+(?:[.,]\d+)?)\s*%/)
  if (pct && !/aument|increment|sub[ií]|recarg|interes/.test(t)) {
    const value = Math.round(parseFloat(pct[1].replace(',', '.')))
    if (value >= 1 && value <= 99) {
      return { kind: 'ops', ops: [{ op: 'set_price', line, mode: 'percent', value }] }
    }
    return null
  }
  if (/\bsac[ao]|quit[ao]|elimin[ao]|borr[ao]|no va|afuera\b/.test(t)) {
    return { kind: 'ops', ops: [{ op: 'remove', line }] }
  }
  const qty = t.match(/(?:x\s*(\d{1,3})|cantidad\s*(\d{1,3})|(?:ponela|ponelo|dejala|dejalo|sean|que sean)\s*(\d{1,3}))/i)
  const q = qty ? parseInt(qty[1] ?? qty[2] ?? qty[3], 10) : NaN
  if (Number.isFinite(q) && q >= 1 && q <= 99) {
    return { kind: 'ops', ops: [{ op: 'set_quantity', line, value: q }] }
  }
  return null
}

function validOp(raw: unknown): ChangeOp | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as { op?: unknown; line?: unknown; mode?: unknown; value?: unknown }
  const lineRaw = o.line
  const line = lineRaw === 'all' ? 'all' : typeof lineRaw === 'number' ? lineRaw : Number(lineRaw)
  const value = typeof o.value === 'number' ? o.value : Number(o.value)

  if (o.op === 'remove') {
    return Number.isInteger(line) && (line as number) >= 1 && (line as number) <= 99
      ? { op: 'remove', line: line as number }
      : null
  }
  if (o.op === 'set_quantity') {
    return Number.isInteger(line) &&
      (line as number) >= 1 &&
      (line as number) <= 99 &&
      Number.isInteger(value) &&
      value >= 1 &&
      value <= 99
      ? { op: 'set_quantity', line: line as number, value }
      : null
  }
  if (o.op === 'set_price') {
    if (line !== 'all' && (!Number.isInteger(line) || (line as number) < 1 || (line as number) > 99)) return null
    if (o.mode !== 'absolute' && o.mode !== 'percent') return null
    if (!Number.isFinite(value) || value <= 0) return null
    if (o.mode === 'percent' && (value < 1 || value > 99)) return null
    return { op: 'set_price', line: line as number | 'all', mode: o.mode, value: Math.round(value) }
  }
  return null
}

function parseResult(raw: unknown): ChangeResult {
  if (!raw || typeof raw !== 'object') return NONE
  const o = raw as { ops?: unknown; unsupported?: unknown; none?: unknown }
  if (typeof o.unsupported === 'string' && o.unsupported.trim()) {
    return { kind: 'unsupported', motivo: o.unsupported.trim() }
  }
  if (Array.isArray(o.ops)) {
    const ops = o.ops.map(validOp).filter((x): x is ChangeOp => x !== null)
    if (ops.length > 0) return { kind: 'ops', ops }
  }
  return NONE
}

export async function interpretQuoteChanges(
  text: string,
  lines: QuoteLine[],
): Promise<ChangeResult> {
  if (!text || !text.trim() || lines.length === 0) return NONE
  const fast = fastQuoteChanges(text)
  if (fast) return fast
  try {
    const linesText = lines
      .map((l) => `${l.n}. ${l.cantidad > 1 ? `${l.cantidad}x ` : ''}${l.descripcion} — $${(l.precio ?? 0).toLocaleString('es-AR')}`)
      .join('\n')
    const res = await callOpenRouter({
      systemPrompt: CHANGE_PROMPT,
      userMessage: `Líneas de la cotización:\n${linesText}\n\nMensaje del usuario: "${text}"`,
      jsonMode: true,
      temperature: 0,
      maxTokens: 200,
      model: process.env.EXTRACTOR_MODEL || undefined,
    })
    const block = res.text.match(/\{[\s\S]*\}/)
    if (!block) return NONE
    return parseResult(JSON.parse(block[0]))
  } catch (err) {
    console.error('[interpret-changes] LLM falló, no se cambia nada:', err instanceof Error ? err.message : String(err))
    return NONE
  }
}

function money(n: number): string {
  return `$${n.toLocaleString('es-AR')}`
}

export type ApplyChangesResult = { items: PedidoItem[]; notes: string[] } | { error: string }

/**
 * Aplica las operaciones sobre los ítems (orden original, incluye faltantes que
 * no se tocan). Las líneas se cuentan como en el chat: solo cotizables.
 */
export function applyQuoteChanges(items: PedidoItem[], ops: ChangeOp[]): ApplyChangesResult {
  let next = items
  const notes: string[] = []

  for (const op of ops) {
    const cotizables = next.filter((it) => !it.faltante)
    const targets =
      op.op === 'set_price' && op.line === 'all'
        ? cotizables
        : [cotizables[(op.line as number) - 1]].filter((x): x is PedidoItem => !!x)

    if (targets.length === 0) {
      return { error: `Esa línea no existe en la cotización. Decime el número tal como aparece arriba.` }
    }
    const bad = targets.find((t) => t.precio_unitario == null)
    if (bad) {
      return { error: `La línea (${bad.descripcion}) está sin precio, no puedo calcular. La vemos a mano.` }
    }
    const revisar = targets.find((t) => t.aRevisar)
    if (revisar) {
      return { error: `La línea (${revisar.descripcion}) está marcada a revisar, prefiero no tocarla hasta confirmar su precio.` }
    }

    if (op.op === 'remove') {
      if (cotizables.length <= 1) {
        return { error: 'No puedo dejar la cotización sin líneas. Si no va nada, la cancelamos.' }
      }
      const target = targets[0]
      next = next.filter((it) => it !== target)
      notes.push(`Saqué la línea ${op.line} (${target.descripcion}).`)
      continue
    }

    if (op.op === 'set_quantity') {
      const target = targets[0]
      next = next.map((it) => (it === target ? { ...it, cantidad: op.value } : it))
      notes.push(`La línea ${op.line} (${target.descripcion}) quedó x${op.value}.`)
      continue
    }

    // set_price
    if (op.mode === 'percent') {
      const before = targets.reduce((a, t) => a + (t.precio_unitario ?? 0) * t.cantidad, 0)
      next = next.map((it) =>
        targets.includes(it) ? { ...it, precio_unitario: roundCatalogPrice((it.precio_unitario ?? 0) * (1 - op.value / 100)) } : it,
      )
      if (next.some((it) => targets.includes(it) && (it.precio_unitario ?? 0) <= 0)) {
        return { error: 'Ese descuento deja la línea en $0. Revisemos el número.' }
      }
      const after = targets.reduce((a, t) => a + (t.precio_unitario ?? 0) * t.cantidad, 0)
      const where = op.line === 'all' ? 'a toda la cotización' : `a la línea ${op.line} (${targets[0].descripcion})`
      const cant = op.line !== 'all' && targets[0].cantidad > 1 ? ` (x${targets[0].cantidad})` : ''
      notes.push(`Apliqué ${op.value}% ${where}${cant}: ${money(before)} → ${money(after)}.`)
      continue
    }

    // set_price absolute
    next = next.map((it) => (targets.includes(it) ? { ...it, precio_unitario: roundCatalogPrice(op.value) } : it))
    if (op.line === 'all') {
      notes.push(`Puse todas las líneas en ${money(roundCatalogPrice(op.value))}.`)
    } else {
      notes.push(`La línea ${op.line} (${targets[0].descripcion}) quedó en ${money(roundCatalogPrice(op.value))}.`)
    }
  }

  return { items: next, notes }
}
