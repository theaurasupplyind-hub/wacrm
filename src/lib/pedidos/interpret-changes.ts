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
import { buildVocabularyPromptBlock, type BotVocabulary } from '@/lib/catalog/vocabulary'
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
  | { op: 'rename'; target: ChangeTarget; name: string; price?: number }

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
- {"op":"rename","line":N|"ref":"...","name":"Nuevo nombre","price":number|null} (renombra una línea y, si "price" viene, le fija el precio)

Reglas:
- set_price "absolute": fija el precio ("poné el bastidor en 300000", "a la pintura dejalo en 50000", "vale 250mil"). "300mil"=300000, "300k"=300000.
- GRATIS / SIN CARGO: "gratis", "sin cargo", "bonificado", "a 0", "ponle 0", "vale 0", "que salga 0" sobre una línea → {"op":"set_price", ..., "mode":"absolute", "value":0}. Nunca es "none".
- set_price "percent": baja un porcentaje ("descontale 10%", "hacele 15%", "bajale 5% a todo"). value 1-99.
- set_quantity: cambia cantidad ("la línea 1 ponela x3", "que sean 2 del chico"). value 1-99.
- remove: saca una línea ("sacá la 2", "quitá el tapacanto", "el rollo no va"). Si el usuario numera varias ("eliminá el 1, el 2 y el 3" / "elimina estos: 1. X 2. Y 3. Z"), devolvé UNA operación remove por cada número.
- rename: renombra una línea y opcionalmente fija su precio ("cambialo que se llame Muestra con Fibro y es gratis" → {"op":"rename","ref":"el bastidor de muestra","name":"Muestra con Fibro","price":0}).
- NUMERACIÓN: las "line" son los números que ve el usuario (1..N de las líneas cotizadas). Si el usuario se refiere a una de esas líneas —aunque escriba la medida con un error de tipeo ("95 x 149" para la línea "95 x 140") o un nombre parcial ("el bastidor de muestra")— devolvé "line": N cuando sea claro e inequívoco. Usá "ref" para un ítem "Sin cotizar" o cuando quieras referirte por texto en vez de por número.
- Un ítem que está "Sin cotizar" (fuera de catálogo) también se puede cotizar: devolvé set_price con "ref" a ese nombre.
- Si nombra algo que no está en la lista → {"unsupported":"no encuentro ese ítem"}.
- Agregar ítems, cambiar cliente/entrega/fecha/descuento general, confirmar o cancelar → {"none":true}.
- Si el mensaje trae una lista de medidas o productos nuevos (ej. "240x120cm (x8)\n60x120cm (x2)"), es un pedido nuevo → {"none":true}. NUNCA uses rename ni set_quantity para reemplazar líneas viejas por un pedido nuevo.
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
    // Fallback tolerante a typos: si un lado de la medida coincide exacto con un
    // único ítem (ej. "95 x 149" → la línea "95 x 140"), lo tomamos.
    const [ms, ml] = mk.split('x').map(Number)
    const near = items.filter((it) => {
      const k = medidaKey(itemBlob(it))
      if (!k) return false
      const [s, l] = k.split('x').map(Number)
      return s === ms || s === ml || l === ms || l === ml
    })
    if (near.length === 1) return near
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
  const o = raw as {
    op?: unknown
    line?: unknown
    ref?: unknown
    mode?: unknown
    value?: unknown
    name?: unknown
    price?: unknown
  }
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
  if (o.op === 'rename') {
    const name = typeof o.name === 'string' ? o.name.trim() : ''
    if (!name) return null
    const priceRaw = o.price == null ? null : typeof o.price === 'number' ? o.price : Number(o.price)
    const price = priceRaw != null && Number.isFinite(priceRaw) && priceRaw >= 0 ? Math.round(priceRaw) : undefined
    return { op: 'rename', target, name, price }
  }
  if (o.op === 'set_price') {
    if (o.mode !== 'absolute' && o.mode !== 'percent') return null
    // "gratis"/"a 0" es un precio absoluto válido ($0).
    if (!Number.isFinite(value) || value < 0) return null
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
  vocab?: BotVocabulary | null,
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
      systemPrompt: `${CHANGE_PROMPT}\n\n${buildVocabularyPromptBlock(vocab, { rules: false })}`,
      userMessage: `Líneas de la cotización:\n${linesText}${pendText}\n\nMensaje del usuario: "${text}"`,
      jsonMode: true,
      temperature: 0,
      maxTokens: 200,
      model: process.env.ORDER_MODEL || 'google/gemini-2.5-flash',
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

  // La numeración visible se fija al INICIO del turno: si se borran varias
  // líneas, los números siguen apuntando a las líneas originales (no se
  // corren). Bug "elimina 1, 2 y 3" borraba 1, 3 y 5 (regresión c9d6f97).
  const initialCotizables = items.filter((it) => !it.faltante)
  const lineOf = (t: PedidoItem): number | null => {
    const idx = initialCotizables.indexOf(t)
    return idx >= 0 ? idx + 1 : null
  }
  const labelFor = (t: PedidoItem, lineNo: number | null): string =>
    lineNo != null ? `la línea ${lineNo} (${t.descripcion})` : describeTarget(next, t)

  for (const op of ops) {
    const cotizables = () => next.filter((it) => !it.faltante)
    let targets: PedidoItem[]
    let lineNo: number | null = null

    if (op.target === 'all') {
      targets = cotizables()
    } else if (typeof op.target === 'number') {
      const t = initialCotizables[op.target - 1]
      if (!t || !next.includes(t)) {
        return { error: 'Esa línea no existe en la cotización. Decime el número tal como aparece arriba.' }
      }
      lineNo = op.target
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
      lineNo = lineOf(found[0])
      targets = [found[0]]
    }

    if (targets.length === 0) return { error: 'No hay líneas para cambiar.' }

    // Guardas: percent/cantidad/quitar necesitan precio; fijar precio absoluto
    // (o un rename con precio) sí puede completar un ítem "a cotizar a mano".
    const needsPrice = !(
      (op.op === 'set_price' && op.mode === 'absolute') ||
      (op.op === 'rename' && op.price != null)
    )
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
      const label = labelFor(target, lineNo)
      next = next.filter((it) => it !== target)
      notes.push(`Saqué ${label}.`)
      continue
    }

    if (op.op === 'set_quantity') {
      const target = targets[0]
      const label = labelFor(target, lineNo)
      next = next.map((it) => (it === target ? { ...it, cantidad: op.value } : it))
      notes.push(`${cap(label)} quedó x${op.value}.`)
      continue
    }

    if (op.op === 'rename') {
      const target = targets[0]
      const label = labelFor(target, lineNo)
      const name = cap(op.name)
      const precio = op.price != null ? roundCatalogPrice(op.price) : null
      next = next.map((it) =>
        it === target
          ? {
              ...it,
              descripcion: name,
              libre: true,
              ...(precio != null
                ? { precio_unitario: precio, faltante: false, precioManual: true }
                : {}),
            }
          : it,
      )
      notes.push(`${cap(label)} ahora es "${name}"${precio != null ? ` y quedó en ${money(precio)}` : ''}.`)
      continue
    }

    // set_price
    if (op.mode === 'percent') {
      const before = targets.reduce((a, t) => a + (t.precio_unitario ?? 0) * t.cantidad, 0)
      const label = op.target === 'all' ? null : labelFor(targets[0], lineNo)
      const newUnits = new Map<PedidoItem, number>()
      for (const t of targets) {
        newUnits.set(t, roundCatalogPrice((t.precio_unitario ?? 0) * (1 - op.value / 100)))
      }
      if ([...newUnits.values()].some((v) => v <= 0)) {
        return { error: 'Ese descuento deja el ítem en $0. Revisemos el número.' }
      }
      next = next.map((it) =>
        newUnits.has(it) ? { ...it, precio_unitario: newUnits.get(it)!, precioManual: true } : it,
      )
      const after = [...newUnits.entries()].reduce((a, [t, unit]) => a + unit * t.cantidad, 0)
      if (op.target === 'all') {
        notes.push(`Apliqué ${op.value}% a toda la cotización: ${money(before)} → ${money(after)}.`)
      } else {
        const cant = targets[0].cantidad > 1 ? ` (x${targets[0].cantidad})` : ''
        notes.push(`Apliqué ${op.value}% a ${label}${cant}: ${money(before)} → ${money(after)}.`)
      }
      continue
    }

    // set_price absolute (acepta 0 = gratis)
    const label = op.target === 'all' ? null : labelFor(targets[0], lineNo)
    const wasPending = targets.some((t) => t.faltante)
    const precio = roundCatalogPrice(op.value)
    next = next.map((it) =>
      targets.includes(it)
        ? {
            ...it,
            precio_unitario: precio,
            faltante: false,
            libre: it.libre ?? true,
            precioManual: true,
          }
        : it,
    )
    if (op.target === 'all') {
      notes.push(`Puse todas las líneas en ${money(precio)}.`)
    } else {
      notes.push(`${cap(label!)} quedó en ${money(precio)}${wasPending ? ' (entra al total)' : ''}.`)
    }
  }

  return { items: next, notes }
}
