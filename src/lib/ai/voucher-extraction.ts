const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

const DEFAULT_MODEL = 'google/gemini-2.5-flash'
const DEFAULT_TIMEOUT_MS = 60_000

export interface VoucherData {
  monto: number | null
  fecha: string | null
  referencia: string | null
  banco: string | null
  nombre_cliente: string | null
}

interface OpenRouterContentPart {
  type: 'text' | 'image_url' | 'file'
  text?: string
  image_url?: { url: string; detail?: 'auto' | 'low' | 'high' }
  file?: { file_data: string; file_name?: string }
}

interface OpenRouterResponse {
  choices?: { message?: { content?: string } }[]
}

const IS_IMAGE = /^image\/(jpeg|png|gif|webp)/i

function resolveModel(): string {
  const env = process.env.VOUCHER_AI_MODEL
  return env && env.trim() ? env.trim() : DEFAULT_MODEL
}

function resolveApiKey(): string {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) {
    throw new Error(
      'OPENROUTER_API_KEY is not set. Add it to your Vercel environment variables.',
    )
  }
  return key
}

/**
 * Call OpenRouter with a multimodal prompt (image or PDF).
 * Returns the raw text response — JSON extraction is handled
 * by `extractVoucherData`.
 */
async function callOpenRouterMultimodal(args: {
  systemPrompt: string
  base64: string
  mimeType: string
  model?: string
}): Promise<string> {
  const { systemPrompt, base64, mimeType, model } = args

  const parts: OpenRouterContentPart[] = [
    { type: 'text', text: systemPrompt },
  ]

  if (IS_IMAGE.test(mimeType)) {
    parts.push({
      type: 'image_url',
      image_url: {
        url: `data:${mimeType};base64,${base64}`,
        detail: 'high',
      },
    })
  } else {
    parts.push({
      type: 'file',
      file: {
        file_data: base64,
        file_name:
          mimeType === 'application/pdf' ? 'documento.pdf' : 'archivo',
      },
    })
  }

  const apiKey = resolveApiKey()
  const selectedModel = model || resolveModel()

  let res: Response
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: selectedModel,
        messages: [
          {
            role: 'user',
            content: parts,
          },
        ],
        max_tokens: 1024,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error('OpenRouter tardó demasiado en responder.')
    }
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Error al contactar OpenRouter: ${msg}`)
  }

  if (!res.ok) {
    let detail = ''
    try {
      const body = (await res.json()) as { error?: { message?: string } }
      detail = body?.error?.message || ''
    } catch {
      // non-JSON error body
    }
    throw new Error(
      `OpenRouter respondió con error ${res.status}${detail ? `: ${detail}` : ''}`,
    )
  }

  const data = (await res.json().catch(() => null)) as OpenRouterResponse | null
  const text = data?.choices?.[0]?.message?.content
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new Error('OpenRouter devolvió una respuesta vacía.')
  }

  return text
}

/**
 * Extract a JSON block from a model response that might have
 * surrounding markdown or text.
 */
function extractJsonBlock(text: string): string {
  const cleaned = text.trim()

  const codeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlock?.[1]) {
    return codeBlock[1].trim()
  }

  const firstBrace = cleaned.indexOf('{')
  const lastBrace = cleaned.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return cleaned.slice(firstBrace, lastBrace + 1)
  }

  return cleaned
}

/**
 * Parse the extracted JSON into a validated VoucherData object.
 */
function parseVoucherJson(raw: string): VoucherData {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(
      'No se pudo interpretar la respuesta de la IA como JSON. Texto recibido: ' +
        raw.slice(0, 200),
    )
  }

  const monto = typeof parsed.monto === 'number' && Number.isFinite(parsed.monto)
    ? parsed.monto
    : typeof parsed.monto === 'string'
      ? parseFloat(parsed.monto)
      : null

  return {
    monto: monto && Number.isFinite(monto) ? monto : null,
    fecha: typeof parsed.fecha === 'string' && parsed.fecha.trim()
      ? parsed.fecha.trim()
      : null,
    referencia: typeof parsed.referencia === 'string' && parsed.referencia.trim()
      ? parsed.referencia.trim()
      : null,
    banco: typeof parsed.banco === 'string' && parsed.banco.trim()
      ? parsed.banco.trim()
      : null,
    nombre_cliente: typeof parsed.nombre_cliente === 'string' && parsed.nombre_cliente.trim()
      ? parsed.nombre_cliente.trim()
      : null,
  }
}

const VOUCHER_SYSTEM_PROMPT = `Analizá esta imagen o PDF de un comprobante de pago (transferencia bancaria, Mercado Pago, etc.).

Devolvé EXCLUSIVAMENTE un JSON sin texto adicional, con este formato:
{
  "monto": número (ej: 15000.50, sin signo de pesos),
  "fecha": string (ej: "15/03/2026", null si no se ve),
  "referencia": string (número de operación, comprobante o referencia, null si no se ve),
  "banco": string (nombre del banco o billetera, null si no se ve),
  "nombre_cliente": string (nombre del remitente o cliente que aparece en el comprobante, null si no se ve)
}

Reglas:
- Si un campo no se distingue claramente, poné null.
- No inventes datos si la imagen está borrosa o no se lee bien.
- El monto debe ser solo el número, sin símbolos ni texto.`

export async function extractVoucherData(args: {
  base64: string
  mimeType: string
  model?: string
}): Promise<VoucherData> {
  const text = await callOpenRouterMultimodal({
    systemPrompt: VOUCHER_SYSTEM_PROMPT,
    base64: args.base64,
    mimeType: args.mimeType,
    model: args.model,
  })

  const jsonBlock = extractJsonBlock(text)
  return parseVoucherJson(jsonBlock)
}
