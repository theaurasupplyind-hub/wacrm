/**
 * Intérprete GENERAL de cambios sobre una cotización abierta.
 *
 * El LLM traduce el mensaje a OPERACIONES TIPADAS; la resolución a qué ítem
 * apuntan y la aritmética son DETERMINÍSTICAS acá (el modelo nunca calcula
 * precios). El usuario puede referirse a una línea por:
 *   - número ("producto 1", "línea 2"),
 *   - medida ("el de 40 x 89"),
 *   - nombre de producto ("el bastidor lienzo profesional"),
 * y también aclarar el precio de un ítem "a cotizar a mano" (fuera de catálogo).
 *
 * Resultado:
 *  - `ops`         → cambios concretos.
 *  - `unsupported` → pidió un cambio que no sabemos hacer (se responde honesto).
 *  - `none`        → no es un cambio de línea → lo maneja otro flujo.
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

/** A qué apunta una operación: número de línea visible, "todas", o una referencia textual. */
export type ChangeTarget = number | 'all' | { text: string }

export type ChangeOp =
  | { op: 'set_price'; target: ChangeTarget; mode: 'absolute' | 'percent'; value: number }
  | { op: 'set_quantity'; target: number | { text: string }; value: number }
  | { op: 'remove'; target: number | { text: string } }

export type ChangeResult =
  | { kind: 'ops'; ops: ChangeOp[] }
  | { kind: 'unsupported'; motivo: string }
  | { kind: 'none' }

const NONE: ChangeResult = { kind: 'none' }

const CHANGE_PROMPT = `Sos el intérprete de cambios sobre una cotización abierta en un taller de marcos. El usuario ve líneas numeradas. Devolvé EXCLUSIVAMENTE un JSON con UNA de estas formas:
{"ops":[ ... ]} para aplicar cambios,
{"unsupported":"motivo corto"} si pide un cambio que no podés resolver,
{"none":true} si NO es un cambio sobre las líneas de la cotización.

Operaciones válidas (usá "line" para el número visible, o "ref" con el texto que dio el usuario):
- {"op":"set_price","line":N|"all","mode":"absolute"|"percent","value":number}
- {"op":"set_price","ref":"bastidor 40 x 89","mode":"absolute"|"percent","value":number}
- {"op":"set_quantity","line":N,"value":number}  o  {"op":"set_quantity","ref":"el chico","value":number}
- {"op":"remove","line":N}  o  {"op":"remove","ref":"el tapacanto"}

Reglas:
- set_price "absolute": fija el precio ("poné el bastidor en 300000", "a la pintura dejalo en 50000", "vale 250mil"). "300mil"=300000, "300k"=300000.
- set_price "percent": baja un porcentaje ("descontale 10%", "hacele 15%", "bajale 5% a todo"). value 1-99.
- set_quantity: cambia cantidad ("la línea 1 ponela x3", "que sean 2 del chico"). value 1-99.
- remove: saca una línea ("sacá la 2", "quitá el tapacanto", "el rollo no va").
- Preferí "ref" con el texto EXACTO que usó el usuario cuando nombra por medida o producto ("40 x 89", "bastidor lienzo profesional", "palos de metal"). Usá "line" solo si dijo un número.
- Un ítem que está "Sin cotizar" (fuera de catálogo) también se puede cotizar: devolvé set_price con "ref" a ese nombre.
- Si nombra algo que no está en la lista → {"unsupported":"no encuentro ese ítem"}.
- Agregar ítems, cambiar cliente/entrega/fecha/descuento general, confirmar o cancelar → {"none":true}.
DEVOLVÉ SOLO EL JSON.`

const STOPWORDS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'y', 'a', 'en', 'con', 'para', 'al', 'unos', 'unas'])

function norm(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
}

function refTokens(text: string): string[] {
  return norm(text)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
}

/** Clave de medida "menorxmayor" de un texto, o null. */
function medidaKey(text: string): string | null {
  const m = norm(text).match(/(\d+(?:[.,]\d+)?)\s*x\s*(\d+(?:[.,]\d+)?)/)
  if (!m) return null
  const a = parseFloat(m[1].replace(',', '.'))
  const b = parseFloat(m[2].replace(',', '.'))
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return `${Math.min(a, b)}x${Math.max(a, b)}`
}

function itemBlob(it: PedidoItem): string {
  return `${it.medida ?? ''} ${it.descripcion}`
}

/** Ítems que coinciden con una referencia textual (por medida o por palabras). */
export function findTargets(items: PedidoItem[], text: string): PedidoItem[] {
  const mk = medidaKey(text)
  if (mk) {
    const byMedida = items.filter((it) => medidaKey(itemBlob(it)) === mk)
    if (byMedida.length > 0) return byMedida
  }
  const toks = refTokens(text)
  if (toks.length === 0) return []
  return items.filter((it) => {
    const dt = refTokens(itemBlob(it))
    return toks.every((t) => dt.some((d) => d === t || d.startsWith(t) || t.startsWith(d)))
  })
}

function lineNumber(items: PedidoItem[], item: PedidoItem): number | null {
  const cotizables = items.filter((it) => !it.faltante)
  const idx = cotizables.indexOf(item)
  return idx >= 0 ? idx + 1 : null
}

/** Etiqueta para el mensaje: "la línea N (desc)" si es cotizable, si no el nombre. */
function describeTarget(items: PedidoItem[], item: PedidoItem): string {
  const n = lineNumber(items, item)
  return n != null ? `la línea ${n} (${item.descripcion})` : `"${item.descripcion}"`
}

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

/**
 * Fast path sin LLM: referencia explícita "línea/item N" con % / quitar /
 * cantidad. Devuelve `null` si no matchea (el LLM intenta por nombre/medida).
 */
export function fastQuoteChanges(text: string): ChangeResult | null {
  const t = norm(text)
  const lineRef = t.match(/(?:linea|item|producto)\s+(\d{1,2})/)
  if (!lineRef) return null
  const line = parseInt(lineRef[1], 10)
  if (!Number.isFinite(line) || line < 1) return null

  const pct = t.match(/(\d+(?:[.,]\d+)?)\s*%/)
  if (pct && !/aument|increment|sub[ií]|recarg|interes/.test(t)) {
    const value = Math.round(parseFloat(pct[1].replace(',', '.')))
    if (value >= 1 && value <= 99) {
      return { kind: 'ops', ops: [{ op: 'set_price', target: line, mode: 'percent', value }] }
    }
    return null
  }
  if (/\bsac[ao]|quit[ao]|elimin[ao]|borr[ao]|no va|afuera\b/.test(t)) {
    return { kind: 'ops', ops: [{ op: 'remove', target: line }] }
  }
  const qty = t.match(/(?:x\s*(\d{1,3})|cantidad\s*(\d{1,3})|(?:ponela|ponelo|dejala|dejalo|sean|que sean)\s*(\d{1,3}))/i)
  const q = qty ? parseInt(qty[1] ?? qty[2] ?? qty[3], 10) : NaN
  if (Number.isFinite(q) && q >= 1 && q <= 99) {
    return { kind: 'ops', ops: [{ op: 'set_quantity', target: line, value: q }] }
  }
  return null
}

function parseTarget(o: { line?: unknown; ref?: unknown }): ChangeTarget | null {
  if (o.line === 'all') return 'all'
  if (typeof o.line === 'number' && Number.isInteger(o.line) && o.line >= 1 && o.line <= 99) return o.line
  if (typeof o.line === 'string' && /^\d{1,2}$/.test(o.line)) {
    const n = parseInt(o.line, 10)
    if (n >= 1 && n <= 99) return n
  }
  if (typeof o.ref === 'string' && o.ref.trim()) return { text: o.ref.trim() }
  return null
}

function validOp(raw: unknown): ChangeOp | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as { op?: unknown; line?: unknown; ref?: unknown; mode?: unknown; value?: unknown }
  const target = parseTarget(o)
  if (target === null) return null
  const value = typeof o.value === 'number' ? o.value : Number(o.value)

  if (o.op === 'remove') {
    return target === 'all' ? null : { op: 'remove', target }
  }
  if (o.op === 'set_quantity') {
    return target === 'all' || !Number.isInteger(value) || value < 1 || value > 99
      ? null
      : { op: 'set_quantity', target, value }
  }
  if (o.op === 'set_price') {
    if (o.mode !== 'absolute' && o.mode !== 'percent') return null
    if (!Number.isFinite(value) || value <= 0) return null
    if (o.mode === 'percent' && (value < 1 || value > 99)) return null
    return { op: 'set_price', target, mode: o.mode, value: Math.round(value) }
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
  pendientes: string[] = [],
): Promise<ChangeResult> {
  if (!text || !text.trim()) return NONE
  if (lines.length === 0 && pendientes.length === 0) return NONE
  const fast = fastQuoteChanges(text)
  if (fast) return fast
  try {
    const linesText = lines
      .map((l) => `${l.n}. ${l.cantidad > 1 ? `${l.cantidad}x ` : ''}${l.descripcion} — $${(l.precio ?? 0).toLocaleString('es-AR')}`)
      .join('\n')
    const pendText = pendientes.length > 0 ? `\nSin cotizar (fuera de catálogo): ${pendientes.join(', ')}` : ''
    const res = await callOpenRouter({
      systemPrompt: CHANGE_PROMPT,
      userMessage: `Líneas de la cotización:\n${linesText}${pendText}\n\nMensaje del usuario: "${text}"`,
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

export type ApplyChangesResult =
  | { items: PedidoItem[]; notes: string[] }
  | { error: string }
  | { ambiguous: { text: string; options: { n: number | null; descripcion: string }[] } }

/**
 * Aplica las operaciones de forma determinística. La línea se resuelve por
 * número, por medida o por nombre (con aviso de ambigüedad). Un ítem "a cotizar
 * a mano" (faltante) puede recibir precio y pasa a entrar en el total.
 */
export function applyQuoteChanges(items: PedidoItem[], ops: ChangeOp[]): ApplyChangesResult {
  let next = items
  const notes: string[] = []

  for (const op of ops) {
    const cotizables = () => next.filter((it) => !it.faltante)
    let targets: PedidoItem[]

    if (op.target === 'all') {
      targets = cotizables()
    } else if (typeof op.target === 'number') {
      const t = cotizables()[op.target - 1]
      if (!t) return { error: 'Esa línea no existe en la cotización. Decime el número tal como aparece arriba.' }
      targets = [t]
    } else {
      const found = findTargets(next, op.target.text)
      if (found.length === 0) {
        return { error: `No encontré "${op.target.text}" en la cotización. Decime el número de línea o el nombre.` }
      }
      if (found.length > 1) {
        return {
          ambiguous: {
            text: op.target.text,
            options: found.map((f) => ({ n: lineNumber(next, f), descripcion: f.descripcion })),
          },
        }
      }
      targets = [found[0]]
    }

    if (targets.length === 0) return { error: 'No hay líneas para cambiar.' }

    // Guardas: percent/cantidad/quitar necesitan precio; fijar precio absoluto
    // sí puede completar un ítem "a cotizar a mano".
    const needsPrice = !(op.op === 'set_price' && op.mode === 'absolute')
    if (needsPrice) {
      const bad = targets.find((t) => t.precio_unitario == null)
      if (bad) return { error: `El ítem "${bad.descripcion}" está sin precio, no puedo calcular. Dale un precio o la vemos a mano.` }
      const revisar = targets.find((t) => t.aRevisar)
      if (revisar) return { error: `El ítem "${revisar.descripcion}" está marcado a revisar, prefiero no tocarlo hasta confirmar su precio.` }
    }

    if (op.op === 'remove') {
      const target = targets[0]
      if (!target.faltante && cotizables().length <= 1) {
        return { error: 'No puedo dejar la cotización sin líneas. Si no va nada, la cancelamos.' }
      }
      const label = describeTarget(next, target)
      next = next.filter((it) => it !== target)
      notes.push(`Saqué ${label}.`)
      continue
    }

    if (op.op === 'set_quantity') {
      const target = targets[0]
      const label = describeTarget(next, target)
      next = next.map((it) => (it === target ? { ...it, cantidad: op.value } : it))
      notes.push(`${cap(label)} quedó x${op.value}.`)
      continue
    }

    // set_price
    if (op.mode === 'percent') {
      const before = targets.reduce((a, t) => a + (t.precio_unitario ?? 0) * t.cantidad, 0)
      const label = op.target === 'all' ? null : describeTarget(next, targets[0])
      const newUnits = new Map<PedidoItem, number>()
      for (const t of targets) {
        newUnits.set(t, roundCatalogPrice((t.precio_unitario ?? 0) * (1 - op.value / 100)))
      }
      if ([...newUnits.values()].some((v) => v <= 0)) {
        return { error: 'Ese descuento deja el ítem en $0. Revisemos el número.' }
      }
      next = next.map((it) => (newUnits.has(it) ? { ...it, precio_unitario: newUnits.get(it)! } : it))
      const after = [...newUnits.entries()].reduce((a, [t, unit]) => a + unit * t.cantidad, 0)
      if (op.target === 'all') {
        notes.push(`Apliqué ${op.value}% a toda la cotización: ${money(before)} → ${money(after)}.`)
      } else {
        const cant = targets[0].cantidad > 1 ? ` (x${targets[0].cantidad})` : ''
        notes.push(`Apliqué ${op.value}% a ${label}${cant}: ${money(before)} → ${money(after)}.`)
      }
      continue
    }

    // set_price absolute
    const label = op.target === 'all' ? null : describeTarget(next, targets[0])
    const wasPending = targets.some((t) => t.faltante)
    next = next.map((it) =>
      targets.includes(it) ? { ...it, precio_unitario: roundCatalogPrice(op.value), faltante: false } : it,
    )
    if (op.target === 'all') {
      notes.push(`Puse todas las líneas en ${money(roundCatalogPrice(op.value))}.`)
    } else {
      notes.push(`${cap(label!)} quedó en ${money(roundCatalogPrice(op.value))}${wasPending ? ' (entra al total)' : ''}.`)
    }
  }

  return { items: next, notes }
}
