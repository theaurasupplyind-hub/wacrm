import { callOpenRouter } from '@/lib/ai/openrouter'
import type { VoiceOrderLog, ParsedOrder, ParsedOrderItem, ParsedOrderType, Confidence, VoiceOrderItem } from './types'

const PARSE_PROMPT = `Sos un sistema de extracción de órdenes de presupuesto para Bastidores GAL (taller de marcos y molduras).

Del texto del cliente extraé la orden y devolvé UNICAMENTE un JSON con esta estructura:

{
  "tipo": "presupuesto" | "respuesta_variante" | "respuesta_confirmacion" | "respuesta_cancelacion",
  "confianza": "alta" | "baja",
  "cliente_nombre": "nombre completo del cliente o null si no se menciona",
  "items": [
    {
      "descripcion": "descripción textual del producto TAL COMO LA DIJO EL CLIENTE",
      "cantidad": número entero (1 si no se especifica)
    }
  ],
  "entidades": [
    {
      "categoria": "bastidor" | "acrilico" | "circular" | "producto" | null,
      "medida": "medida normalizada (ej: 60x40, 100x120, 2x5)" | null,
      "variante": "Sin Tela" | "Lienzo Profesional" | "Lona Preparada" | "Doble 4cm" | null,
      "cantidad": número,
      "descripcion_original": "mismo texto que en items.descripcion"
    }
  ],
  "variante_respuesta": "texto exacto de la variante que dijo | null"
}

=== TIPOS DE RESPUESTA ===

- "presupuesto": el cliente pide precio de productos nuevos con medidas y cantidades
- "respuesta_variante": el cliente responde SOLO con una variante (ej: "sin tela", "lienzo profesional", "doble 4cm", "lp", "con tela")
- "respuesta_confirmacion": el cliente confirma (ej: "confirmar", "si", "dale", "ok", "guarda", "mandalo", "joya")
- "respuesta_cancelacion": el cliente cancela (ej: "cancelar", "no", "nada", "borrar", "descartar", "cancelado")

=== REGLAS ===

- Si el texto parece una RESPUESTA simple (una variante, color, tipo), sin mencionar productos nuevos, devolvé tipo "respuesta_variante". La variante exacta que dijo va en variante_respuesta.
- Si el texto menciona productos con cantidades y medidas, devolvé "presupuesto". En entidades, extraé categoria, medida y variante si son claros (si no están claros, poné null).
- Si dice "a nombre de X" o "para X", ese es el cliente_nombre.
- confianza: "alta" si el mensaje es claro y sin ambigüedad. "baja" si hay que inferir o si el mensaje es genérico.
- descripcion en items debe ser TEXTUAL: copiá exactamente lo que dijo el cliente.
- Normalizá medidas en entidades: "100x0,60" → "60x100", el número mayor primero.
- Si no se puede determinar categoria en entidades, dejá null en lugar de inventar.

=== FEW-SHOT EXAMPLES ===

Mensaje: "Hola quiero precio de 3 bastidores 60x40 sin tela"
{"tipo":"presupuesto","confianza":"alta","cliente_nombre":null,"items":[{"descripcion":"3 bastidores 60x40 sin tela","cantidad":3}],"entidades":[{"categoria":"bastidor","medida":"60x40","variante":"Sin Tela","cantidad":3,"descripcion_original":"3 bastidores 60x40 sin tela"}],"variante_respuesta":null}

Mensaje: "2 acrilicos 50x70 y 1 circular 30x30"
{"tipo":"presupuesto","confianza":"alta","cliente_nombre":null,"items":[{"descripcion":"2 acrilicos 50x70","cantidad":2},{"descripcion":"1 circular 30x30","cantidad":1}],"entidades":[{"categoria":"acrilico","medida":"50x70","variante":null,"cantidad":2,"descripcion_original":"2 acrilicos 50x70"},{"categoria":"circular","medida":"30x30","variante":null,"cantidad":1,"descripcion_original":"1 circular 30x30"}],"variante_respuesta":null}

Mensaje: "sin tela"
{"tipo":"respuesta_variante","confianza":"alta","cliente_nombre":null,"items":[],"entidades":[],"variante_respuesta":"sin tela"}

Mensaje: "confirmar pedido"
{"tipo":"respuesta_confirmacion","confianza":"alta","cliente_nombre":null,"items":[],"entidades":[],"variante_respuesta":null}

Mensaje: "cancelar"
{"tipo":"respuesta_cancelacion","confianza":"alta","cliente_nombre":null,"items":[],"entidades":[],"variante_respuesta":null}

Mensaje: "dale mandalo"
{"tipo":"respuesta_confirmacion","confianza":"baja","cliente_nombre":null,"items":[],"entidades":[],"variante_respuesta":null}

Mensaje: "uno de 90x10 sin tela y dos de 60x40 lienzo profesional"
{"tipo":"presupuesto","confianza":"alta","cliente_nombre":null,"items":[{"descripcion":"uno de 90x10 sin tela","cantidad":1},{"descripcion":"dos de 60x40 lienzo profesional","cantidad":2}],"entidades":[{"categoria":"bastidor","medida":"90x10","variante":"Sin Tela","cantidad":1,"descripcion_original":"uno de 90x10 sin tela"},{"categoria":"bastidor","medida":"60x40","variante":"Lienzo Profesional","cantidad":2,"descripcion_original":"dos de 60x40 lienzo profesional"}],"variante_respuesta":null}

DEVOLVÉ SOLO EL JSON, NADA MAS.`

function guessTipo(raw: Record<string, unknown>): ParsedOrderType {
  const tipo = String(raw.tipo || '')
  if (tipo === 'respuesta_variante' || tipo === 'respuesta_confirmacion' || tipo === 'respuesta_cancelacion') {
    return tipo
  }
  return 'presupuesto'
}

function guessConfianza(raw: Record<string, unknown>): Confidence {
  return String(raw.confianza || '') === 'baja' ? 'baja' : 'alta'
}

function parseItems(raw: unknown): VoiceOrderItem[] {
  if (!Array.isArray(raw)) return []
  return raw.map((i: Record<string, unknown>) => ({
    descripcion: String(i.descripcion || ''),
    cantidad: Math.max(1, parseInt(String(i.cantidad || '1'), 10)),
  })).filter(i => i.descripcion)
}

function parseEntidades(raw: unknown): ParsedOrderItem[] {
  if (!Array.isArray(raw)) return []
  return raw.map((e: Record<string, unknown>) => ({
    categoria: e.categoria != null ? String(e.categoria) : null,
    medida: e.medida != null ? String(e.medida) : null,
    variante: e.variante != null ? String(e.variante) : null,
    cantidad: Math.max(1, parseInt(String(e.cantidad || '1'), 10)),
    descripcion_original: String(e.descripcion_original || ''),
  })).filter(e => e.descripcion_original)
}

function extractJson(raw: string): string | null {
  const match = raw.match(/\{[\s\S]*\}/)
  return match ? match[0] : null
}

export async function parseOrder(
  text: string,
  phone: string,
  logs: VoiceOrderLog[],
  historyText?: string,
): Promise<ParsedOrder> {
  const t0 = Date.now()

  const userMessage = historyText
    ? `ÚLTIMOS MENSAJES:\n${historyText}\n\nMENSAJE ACTUAL: ${text}`
    : text

  const defaultResult: ParsedOrder = {
    tipo: 'presupuesto',
    confianza: 'baja',
    cliente_nombre: `Cliente ${phone}`,
    items: [{ descripcion: text, cantidad: 1 }],
    entidades: [],
    variante_respuesta: null,
  }

  let rawText: string
  try {
    const result = await callOpenRouter({
      systemPrompt: PARSE_PROMPT,
      userMessage,
      jsonMode: true,
      temperature: 0.1,
      maxTokens: 600,
    })
    rawText = result.text
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logs.push({ step: 'voice_parse_error', data: { error: msg } })
    console.error('[parseOrder] LLM call failed:', msg)
    return defaultResult
  }

  const jsonStr = extractJson(rawText)
  if (!jsonStr) {
    logs.push({ step: 'voice_parse_error', data: { error: 'No JSON in response', raw: rawText.slice(0, 200) } })
    console.error('[parseOrder] No JSON found:', rawText.slice(0, 200))
    return defaultResult
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    logs.push({ step: 'voice_parse_error', data: { error: 'Invalid JSON', raw: jsonStr.slice(0, 200) } })
    console.error('[parseOrder] Invalid JSON:', jsonStr.slice(0, 200))
    return defaultResult
  }

  const tipo = guessTipo(parsed)
  const confianza = guessConfianza(parsed)
  const items = parseItems(parsed.items)
  const entidades = parseEntidades(parsed.entidades)

  const result: ParsedOrder = {
    tipo,
    confianza,
    cliente_nombre: (parsed.cliente_nombre as string) || (tipo === 'respuesta_variante' ? null : `Cliente ${phone}`),
    items: items.length > 0 ? items : defaultResult.items,
    entidades,
    variante_respuesta: parsed.variante_respuesta as string | null ?? null,
  }

  logs.push({
    step: 'voice_parse',
    data: {
      model: 'google/gemini-2.5-flash-lite',
      tipo: result.tipo,
      confianza: result.confianza,
      cliente_extraido: result.cliente_nombre,
      items_extraidos: result.items.length,
      entidades_extraidas: result.entidades.length,
      variante_respuesta: result.variante_respuesta,
      items: result.items.map(i => `${i.cantidad}x ${i.descripcion}`),
      has_history: !!historyText,
      duration_ms: Date.now() - t0,
    },
  })

  return result
}
