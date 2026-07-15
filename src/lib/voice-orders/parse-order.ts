import type { VoiceOrderLog, ParsedOrder } from './types'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const TIMEOUT_MS = 20_000
const DEFAULT_MODEL = 'google/gemini-2.5-flash-lite'

const PARSE_PROMPT = `Sos un sistema de extracción de órdenes de presupuesto para Bastidores GAL (taller de marcos y molduras).

Del texto del cliente extraé la orden. Podés devolver dos tipos de respuestas:

=== TIPO 1: PRESUPUESTO (pedido normal) ===
{
  "tipo": "presupuesto",
  "cliente_nombre": "nombre completo del cliente, null si no se menciona",
  "items": [
    {
      "descripcion": "descripción textual del producto TAL COMO LA DIJO EL CLIENTE",
      "cantidad": número entero (1 si no se especifica)
    }
  ]
}

=== TIPO 2: RESPUESTA DE VARIANTE (el cliente está respondiendo a una pregunta) ===
Ej: si el texto es solo "sin tela", "lienzo profesional", "lp", "doble 4cm", "con tela"
{
  "tipo": "respuesta_variante",
  "cliente_nombre": null,
  "items": [],
  "variante_respuesta": "texto de la variante exacta que dijo"
}

Reglas:
- Si el texto parece una RESPUESTA simple (una variante, color, tipo),
  sin mencionar productos nuevos, devolvé tipo "respuesta_variante"
- Si el texto menciona productos con cantidades y medidas, devolvé "presupuesto"
- descripcion debe ser TEXTUAL, copiá exactamente lo que dijo el cliente
- Si dice "a nombre de X" o "para X", ese es el cliente_nombre`

export async function parseOrder(
  text: string,
  phone: string,
  logs: VoiceOrderLog[],
): Promise<ParsedOrder> {
  const t0 = Date.now()
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set')

  const model = process.env.VOICE_ORDER_PARSE_MODEL || DEFAULT_MODEL

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: PARSE_PROMPT },
        { role: 'user', content: text },
      ],
      max_tokens: 512,
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  if (!res.ok) {
    let detail = ''
    try {
      const body = (await res.json()) as { error?: { message?: string } }
      detail = body?.error?.message || ''
    } catch { /* ignore */ }
    throw new Error(`Parse LLM error ${res.status}${detail ? `: ${detail}` : ''}`)
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[]
    usage?: { prompt_tokens: number; completion_tokens: number }
  }
  const raw = data?.choices?.[0]?.message?.content
  if (!raw || !raw.trim()) throw new Error('LLM devolvió respuesta vacía.')

  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('No se pudo extraer JSON de la respuesta del LLM.')

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(jsonMatch[0])
  } catch {
    throw new Error('JSON inválido devuelto por el LLM.')
  }

  const tipo = parsed.tipo as string || 'presupuesto'
  const result: ParsedOrder = {
    tipo: tipo === 'respuesta_variante' ? 'respuesta_variante' : 'presupuesto',
    cliente_nombre: (parsed.cliente_nombre as string) || (tipo === 'respuesta_variante' ? null : `Cliente ${phone}`),
    items: Array.isArray(parsed.items)
      ? parsed.items.map((i: Record<string, unknown>) => ({
          descripcion: String(i.descripcion || ''),
          cantidad: Math.max(1, parseInt(String(i.cantidad || '1'), 10)),
        })).filter(i => i.descripcion)
      : [],
    variante_respuesta: parsed.variante_respuesta as string | undefined,
  }

  logs.push({
    step: 'voice_parse',
    data: {
      model,
      tipo: result.tipo,
      cliente_extraido: result.cliente_nombre,
      items_extraidos: result.items.length,
      variante_respuesta: result.variante_respuesta,
      items: result.items.map(i => `${i.cantidad}x ${i.descripcion}`),
      tokens_in: data.usage?.prompt_tokens ?? 0,
      tokens_out: data.usage?.completion_tokens ?? 0,
      duration_ms: Date.now() - t0,
    },
  })

  return result
}
