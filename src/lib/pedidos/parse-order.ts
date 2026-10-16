// Parseo de pedidos con LLM. NO calcula precios: sólo extrae cliente + ítems
// (cantidad + texto crudo que conserva el vocabulario del usuario). Fallback
// regex si el LLM falla.

import { callOpenRouter } from '@/lib/ai/openrouter'
import { parseDeliveryDate, serializeFechaEntrega } from './dates'
import type { OrderContext, ParsedOrder, ParsedOrderItem, TipoEntrega } from './types'

// `gemini-2.5-flash` (no-lite) sigue instrucciones multi-sección y conserva
// fielmente "sin lienzo" (regresión R2). Override por env si hace falta.
function orderModel(): string {
  return process.env.ORDER_MODEL || 'google/gemini-2.5-flash'
}

const SYSTEM_PROMPT = `Sos un extractor de pedidos de una fábrica de bastidores. Devolvés EXCLUSIVAMENTE un JSON sin texto extra, con este formato:

{
  "cliente": string|null,
  "items": [ { "cantidad": number, "texto": string, "precio": number|null, "libre": boolean } ],
  "tipo_entrega": "Retira"|"Envio"|"Retiro y Envio"|null,
  "fecha_entrega": string|null
}

Reglas:
- Cada ítem conserva las palabras del usuario sobre el producto, la variante y la medida: "sin tela", "lienzo profesional", "lona preparada", "doble 4cm", "pintura", "embastame", "tapacanto", "acrilico", "rollo 2x5". No traduzcas ni agregues sinónimos.
- ENCABEZADOS DE BLOQUE: si el mensaje trae encabezados como "Con lienzo:", "Sin lienzo:", "Sin tela:", cada ítem de ese bloque debe incluir el encabezado COMPLETO en su "texto", incluyendo la palabra "sin" (ej: el bloque "Sin lienzo (con los esquineros atrás):\n200x140cm" → "200x140cm sin lienzo con los esquineros atrás"). NUNCA omitas "sin lienzo"/"sin tela": cambia el precio.
- "libre": true cuando el usuario pide una MUESTRA sin medida ("Bastidor de Muestra con Fibro", "muestra de prueba"), un ítem que aclara que NO tiene medida ("no tiene medida", "sin medida", "no se mide"), o un producto fuera del catálogo ("Palos de metal"), aunque su nombre incluya "bastidor" o "fibro". Si no es ninguno de esos casos, "libre": false.
- Si dice "gratis", "sin cargo", "sin cobrar" o "a 0 pesos" para un ítem, devolvé ese ítem con "precio": 0.
- La cantidad default es 1.
- Un modificador al final de la lista aplica a TODOS los ítems: "56 x 78, 89 x 67, 67 x 56 sin tela" → 3 ítems, todos con "sin tela".
- "N de X" o "N X" → cantidad N del mismo ítem (ej: "5 bastidores 60x40" → cantidad 5).
- "dos más, 58x29, 184x95" → 2 ítems (58x29 y 184x95). Nunca dupliques una medida por una palabra de cantidad.
- Medidas sin categoría quedan tal cual (la categoría por defecto se resuelve después).
- NO inventes precios ni medidas.
- Si el usuario fija un precio para un ítem ("a 0 pesos", "a 20mil", "$50000", "puesto 20000"), devolvé ese precio en "precio" (number, sin símbolo). Si no lo dice, "precio": null.
- Un producto con nombre propio que no conocés ("palos de metal", "soporte X") va como ítem con su texto tal cual, "libre": true y su precio si lo dieron; NO lo cambies por "bastidor".
- cliente: sólo el nombre del cliente si aparece explicito como destinatario ("para Juan", "a Joaquín", "hacele a Matías", "a nombre de Ana"); si no, null. NUNCA tomes el nombre de un saludo ("Hola Jorge..." → Jorge es a quien se saluda, no el cliente → null).
- tipo_entrega: sólo si el usuario lo dice ("retira", "envío", "lo paso a buscar", "te lo mando") → "Retira" | "Envio" | "Retiro y Envio"; si no, null.
- fecha_entrega: sólo si el usuario menciona una fecha de entrega, devolvé el texto tal cual lo dijo (ej: "el viernes", "15/11", "la semana que viene"); si no, null. NO la confundas con medidas.
- Si te paso "pedido_actual" y el mensaje es una CORRECCIÓN, devolvé la lista COMPLETA actualizada (incluyendo los ítems sin cambios). Cambiá solo lo que el usuario pide: NO agregues variantes/modificadores ("sin tela", "lienzo profesional", etc.) a un ítem nuevo si el usuario no los dijo en ESTE mensaje. Si es un pedido nuevo, ignorá "pedido_actual".

Ejemplos:
"embastame una pintura 94x81" → {"cliente":null,"items":[{"cantidad":1,"texto":"pintura 94x81","precio":null,"libre":false}],"tipo_entrega":null,"fecha_entrega":null}
"5 bastidores 60x40, 3 de 60x70 y uno de 90x10" → {"cliente":null,"items":[{"cantidad":5,"texto":"bastidor 60x40","precio":null,"libre":false},{"cantidad":3,"texto":"bastidor 60x70","precio":null,"libre":false},{"cantidad":1,"texto":"bastidor 90x10","precio":null,"libre":false}],"tipo_entrega":null,"fecha_entrega":null}
"56 x 78, 89 x 67, 67 x 56 sin tela" → {"cliente":null,"items":[{"cantidad":1,"texto":"56x78 sin tela","precio":null,"libre":false},{"cantidad":1,"texto":"89x67 sin tela","precio":null,"libre":false},{"cantidad":1,"texto":"67x56 sin tela","precio":null,"libre":false}],"tipo_entrega":null,"fecha_entrega":null}
"hacele a Matías 2 de 60x40 sin tela" → {"cliente":"Matías","items":[{"cantidad":2,"texto":"60x40 sin tela","precio":null,"libre":false}],"tipo_entrega":null,"fecha_entrega":null}
"Hola Jorge, tengo 4 pinturas y un tapiz para embastar" → {"cliente":null,"items":[{"cantidad":4,"texto":"pintura para embastar","precio":null,"libre":false},{"cantidad":1,"texto":"tapiz para embastar","precio":null,"libre":false}],"tipo_entrega":null,"fecha_entrega":null}
"en vez de 60x40 poné 60x50" (pedido_actual: 60x40) → {"cliente":null,"items":[{"cantidad":1,"texto":"60x50","precio":null,"libre":false}],"tipo_entrega":null,"fecha_entrega":null}
(pedido_actual: 1 bastidor 60x40 sin tela) "agregá un rollo de tela 2x5" → {"cliente":null,"items":[{"cantidad":1,"texto":"bastidor 60x40 sin tela","precio":null,"libre":false},{"cantidad":1,"texto":"rollo de tela 2x5","precio":null,"libre":false}],"tipo_entrega":null,"fecha_entrega":null}
"y un Bastidor de Muestra con Fibro" → {"cliente":null,"items":[{"cantidad":1,"texto":"Bastidor de Muestra con Fibro","precio":null,"libre":true}],"tipo_entrega":null,"fecha_entrega":null}
(pedido_actual: 1 Bastidor de Muestra con Fibro) "cambialo que se llame Muestra con Fibro no tiene medida y es gratis" → {"cliente":null,"items":[{"cantidad":1,"texto":"Muestra con Fibro","precio":0,"libre":true}],"tipo_entrega":null,"fecha_entrega":null}
"Con lienzo: 240x120cm (x8)\n\nSin lienzo (con los esquineros atrás): 200x140cm (x2)" → {"cliente":null,"items":[{"cantidad":8,"texto":"240x120cm con lienzo","precio":null,"libre":false},{"cantidad":2,"texto":"200x140cm sin lienzo con los esquineros atrás","precio":null,"libre":false}],"tipo_entrega":null,"fecha_entrega":null}`

function buildUserMessage(text: string, context?: OrderContext | null): string {
  if (context && context.items && context.items.length > 0) {
    const actual = context.items
      .map((it, i) => `${i + 1}. ${it.cantidad > 1 ? `${it.cantidad}x ` : ''}${it.descripcion}`)
      .join('\n')
    return `pedido_actual:\n${actual}\n\nmensaje: ${text}`
  }
  return text
}

function extractJsonBlock(text: string): string {
  const cleaned = text.trim()
  const codeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlock?.[1]) return codeBlock[1].trim()
  const first = cleaned.indexOf('{')
  const last = cleaned.lastIndexOf('}')
  if (first !== -1 && last > first) return cleaned.slice(first, last + 1)
  return cleaned
}

function parseCantidad(value: unknown): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? '').replace(',', '.'))
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.floor(n)
}

function parseOrderJson(raw: string): ParsedOrder {
  const parsed = JSON.parse(raw) as {
    cliente?: unknown
    items?: unknown
    tipo_entrega?: unknown
    fecha_entrega?: unknown
  }
  const cliente = typeof parsed.cliente === 'string' && parsed.cliente.trim() ? parsed.cliente.trim() : null
  const rawItems = Array.isArray(parsed.items) ? parsed.items : []
  const items: ParsedOrderItem[] = []
  for (const it of rawItems) {
    if (!it || typeof it !== 'object') continue
    const obj = it as { cantidad?: unknown; texto?: unknown; precio?: unknown; libre?: unknown }
    const texto = typeof obj.texto === 'string' ? obj.texto.trim() : ''
    if (!texto) continue
    const precioNum = obj.precio == null ? null : Number(obj.precio)
    const precio = precioNum != null && Number.isFinite(precioNum) && precioNum >= 0 ? precioNum : null
    const libre = obj.libre === true
    items.push({ cantidad: parseCantidad(obj.cantidad), texto, precio, libre })
  }

  const tipoRaw = typeof parsed.tipo_entrega === 'string' ? parsed.tipo_entrega.trim() : ''
  const tipoEntrega: TipoEntrega | null =
    tipoRaw === 'Retira' || tipoRaw === 'Envio' || tipoRaw === 'Retiro y Envio'
      ? tipoRaw
      : null

  const fechaTexto = typeof parsed.fecha_entrega === 'string' ? parsed.fecha_entrega.trim() : ''
  const fecha = fechaTexto ? parseDeliveryDate(fechaTexto) : null

  return {
    cliente,
    items,
    tipoEntrega,
    fechaEntrega: fecha ? serializeFechaEntrega(fecha) : null,
  }
}

// ── Fallback regex ──

const WORD_NUMBERS: Record<string, number> = {
  un: 1, una: 1, uno: 1,
  dos: 2, tres: 3, cuatro: 4, cinco: 5,
  seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
}

const MEASURE_SOURCE = /(\d+(?:[.,]\d+)?)\s*[xX×*]\s*(\d+(?:[.,]\d+)?)/.source

const CONNECTOR_WORDS = new Set([
  'y', 'e', 'de', 'del', 'mas', 'más', 'uno', 'una', 'un', 'los', 'las', 'el', 'la', 'para', 'a',
])

function extractCantidad(prefix: string): number {
  const p = prefix.toLowerCase().trim()
  const numMatch = p.match(/(\d+)\s*(?:de\s+)?[a-záéíóúñ]*\s*$/)
  if (numMatch) {
    const n = parseInt(numMatch[1], 10)
    if (n >= 1) return n
  }
  const words = p.split(/\s+/).filter(Boolean)
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i]
    if (WORD_NUMBERS[w] !== undefined) return WORD_NUMBERS[w]
  }
  return 1
}

function stripLeadingQuantity(part: string): string {
  const stripped = part.replace(
    /^\s*(?:\d+|un[oa]?|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s*(?:de\s+|m[aá]s\s+)?/i,
    '',
  )
  const words = stripped.trim().split(/\s+/).filter(Boolean)
  while (words.length > 0 && CONNECTOR_WORDS.has(words[0].toLowerCase())) {
    words.shift()
  }
  return words.join(' ').trim()
}

function looksLikeModifier(text: string): boolean {
  return /\b(sin\s+tela|con\s+tela|lienzo|lona|doble|pintura|tapacanto|acr[ií]lico|embastad)/i.test(text)
}

function extractCliente(text: string): string | null {
  const m = text.match(/\b(?:para|a)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?)/)
  return m ? m[1].trim() : null
}

export function fallbackParseOrder(text: string): ParsedOrder {
  const cliente = extractCliente(text)
  const parts = text
    .split(/[,\n;]+/)
    .map(s => s.trim())
    .filter(Boolean)

  const items: ParsedOrderItem[] = []
  let trailingModifier = ''

  for (const part of parts) {
    const re = new RegExp(MEASURE_SOURCE, 'gi')
    const matches = [...part.matchAll(re)]
    if (matches.length === 0) {
      if (items.length > 0 && looksLikeModifier(part)) trailingModifier = part
      continue
    }

    let segStart = 0
    for (const m of matches) {
      const idx = m.index ?? 0
      const prefix = part.slice(segStart, idx)
      const cantidad = extractCantidad(prefix)
      const productWord = stripLeadingQuantity(prefix)
      items.push({ cantidad, texto: `${productWord} ${m[0]}`.trim() })
      segStart = idx + m[0].length
    }

    // El texto después de la última medida puede ser un modificador de lista
    // ("... 67 x 56 sin tela" aplica a todos los ítems).
    const after = part.slice(segStart).trim()
    if (after && looksLikeModifier(after)) trailingModifier = after
  }

  if (trailingModifier) {
    const mod = trailingModifier.toLowerCase()
    for (const it of items) {
      if (!it.texto.toLowerCase().includes(mod)) {
        it.texto = `${it.texto} ${trailingModifier}`.replace(/\s+/g, ' ').trim()
      }
    }
  }

  return { cliente, items }
}

export async function parseOrder(
  text: string,
  opts: { context?: OrderContext | null; model?: string } = {},
): Promise<ParsedOrder> {
  const userMessage = buildUserMessage(text, opts.context)
  try {
    const res = await callOpenRouter({
      systemPrompt: SYSTEM_PROMPT,
      userMessage,
      jsonMode: true,
      model: opts.model || orderModel(),
      temperature: 0.1,
      maxTokens: 1024,
    })
    const parsed = parseOrderJson(extractJsonBlock(res.text))
    if (parsed.items.length === 0) return fallbackParseOrder(text)
    return parsed
  } catch (err) {
    console.error('[pedido] parseOrder LLM error:', err)
    return fallbackParseOrder(text)
  }
}
