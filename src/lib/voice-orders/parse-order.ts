import type { VoiceOrderLog, ParsedOrder } from './types'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const TIMEOUT_MS = 20_000
const DEFAULT_MODEL = 'google/gemini-2.5-flash-lite'

const PARSE_PROMPT = `Sos un sistema de extracción de órdenes. Del texto siguiente extraé una orden de presupuesto para Bastidores GAL.

Devolvé SOLO JSON sin explicaciones, con esta estructura exacta:
{
  "tipo": "presupuesto",
  "cliente_nombre": "nombre completo del cliente (o null si no se menciona)",
  "items": [
    {
      "categoria": "tipo de producto (BASTIDOR, ACRILICO, CIRCULAR, PINTURA, TAPACANTO, LIENZO, PRODUCTO)",
      "medida": "medidas en formato ANCHOxALTO (ej: 120x130). Si no hay medidas exactas, inferilas del contexto o dejá null",
      "variante": "variante del producto (lienzo profesional, sin tela, gesso, etc. null si no aplica)",
      "cantidad": número entero (1 si no se especifica)
    }
  ]
}

Reglas:
- Categoria SIEMPRE en mayúsculas
- Si no se entiende el producto, usá categoria "PRODUCTO"
- Para "bastidor" la medida suele ser ANCHOxALTO (ej: 60x40, 120x130)
- "lienzo profesional" o "lp" es variante del bastidor
- "sin tela" es variante del bastidor
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

  // Extract JSON from response (handle markdown wrapping)
  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('No se pudo extraer JSON de la respuesta del LLM.')

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(jsonMatch[0])
  } catch {
    throw new Error('JSON inválido devuelto por el LLM.')
  }

  const result: ParsedOrder = {
    tipo: 'presupuesto',
    cliente_nombre: (parsed.cliente_nombre as string) || `Cliente ${phone}`,
    items: Array.isArray(parsed.items)
      ? parsed.items.map((i: Record<string, unknown>) => ({
          categoria: String(i.categoria || 'PRODUCTO').toUpperCase(),
          medida: i.medida ? String(i.medida) : '',
          variante: i.variante ? String(i.variante) : '',
          cantidad: Math.max(1, parseInt(String(i.cantidad || '1'), 10)),
        }))
      : [],
  }

  logs.push({
    step: 'voice_parse',
    data: {
      model,
      cliente_extraido: result.cliente_nombre,
      items_extraidos: result.items.length,
      tokens_in: data.usage?.prompt_tokens ?? 0,
      tokens_out: data.usage?.completion_tokens ?? 0,
      duration_ms: Date.now() - t0,
    },
  })

  return result
}
