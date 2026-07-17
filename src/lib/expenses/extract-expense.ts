import { extractVoucherData } from '@/lib/ai/voucher-extraction'

export interface ExtractedExpenseData {
  monto: number | null
  fecha: string | null
  categoria: string | null
  descripcion: string | null
  proveedor: string | null
  empleado: string | null
  referencia: string | null
  metodo_pago: string | null
}

const EXPENSE_SYSTEM_PROMPT = `Analizá esta imagen o PDF de un comprobante de gasto (factura, ticket, remito, transferencia, etc.).

Devolvé EXCLUSIVAMENTE un JSON sin texto adicional, con este formato:
{
  "monto": número (ej: 15000.50, sin signo de pesos),
  "fecha": string (ej: "15/03/2026", null si no se ve),
  "categoria": string (tipo de gasto: luz, alquiler, sueldo, materiales, etc.; null si no se ve),
  "descripcion": string (breve descripción del gasto, null si no se ve),
  "proveedor": string (nombre del proveedor o destinatario, null si no aplica),
  "empleado": string (nombre del empleado si es un pago de sueldo, null si no aplica),
  "referencia": string (número de factura, remito o comprobante, null si no se ve),
  "metodo_pago": string (efectivo, transferencia, débito, crédito, mercado pago, null si no se ve)
}

Reglas:
- Si un campo no se distingue claramente, poné null.
- No inventes datos si la imagen está borrosa o no se lee bien.
- El monto debe ser solo el número, sin símbolos ni texto.
- La categoría debe ser lo más específica posible.`

export async function extractExpenseData(args: {
  base64: string
  mimeType: string
  model?: string
}): Promise<ExtractedExpenseData> {
  // Reutilizamos la misma función de voucher pero con un prompt diferente.
  // Dado que extractVoucherData no expone el prompt, hacemos una llamada manual.
  return callOpenRouterForExpense({
    base64: args.base64,
    mimeType: args.mimeType,
    model: args.model,
  })
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
const DEFAULT_TIMEOUT_MS = 60_000

function resolveModel(): string {
  const env = process.env.VOUCHER_AI_MODEL
  return env && env.trim() ? env.trim() : 'google/gemini-2.5-flash'
}

function resolveApiKey(): string {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) {
    throw new Error('OPENROUTER_API_KEY is not set.')
  }
  return key
}

async function callOpenRouterForExpense(args: {
  base64: string
  mimeType: string
  model?: string
}): Promise<ExtractedExpenseData> {
  const parts: OpenRouterContentPart[] = [{ type: 'text', text: EXPENSE_SYSTEM_PROMPT }]

  if (IS_IMAGE.test(args.mimeType)) {
    parts.push({
      type: 'image_url',
      image_url: { url: `data:${args.mimeType};base64,${args.base64}`, detail: 'high' },
    })
  } else {
    parts.push({
      type: 'file',
      file: {
        file_data: args.base64,
        file_name: args.mimeType === 'application/pdf' ? 'comprobante.pdf' : 'archivo',
      },
    })
  }

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resolveApiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: args.model || resolveModel(),
      messages: [{ role: 'user', content: parts }],
      max_tokens: 1024,
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  })

  if (!res.ok) {
    let detail = ''
    try {
      const body = (await res.json()) as { error?: { message?: string } }
      detail = body?.error?.message || ''
    } catch {
      // ignore
    }
    throw new Error(`OpenRouter error ${res.status}${detail ? `: ${detail}` : ''}`)
  }

  const data = (await res.json().catch(() => null)) as OpenRouterResponse | null
  const text = data?.choices?.[0]?.message?.content
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new Error('OpenRouter devolvió una respuesta vacía.')
  }

  return parseExpenseJson(extractJsonBlock(text))
}

function extractJsonBlock(text: string): string {
  const cleaned = text.trim()
  const codeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlock?.[1]) return codeBlock[1].trim()
  const firstBrace = cleaned.indexOf('{')
  const lastBrace = cleaned.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return cleaned.slice(firstBrace, lastBrace + 1)
  }
  return cleaned
}

function parseNumberSafe(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    let s = value.trim().replace(/[$\s]/g, '')
    if (s.includes(',') && s.includes('.')) {
      if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
        s = s.replace(/\./g, '').replace(',', '.')
      } else {
        s = s.replace(/,/g, '')
      }
    } else if (s.includes(',')) {
      const parts = s.split(',')
      if (parts.length === 2 && parts[1].length <= 2) {
        s = s.replace(',', '.')
      } else {
        s = s.replace(/,/g, '')
      }
    } else if (s.includes('.')) {
      const parts = s.split('.')
      if (parts.length > 2) {
        s = s.replace(/\./g, '')
      }
    }
    const n = parseFloat(s)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  return null
}

function parseStringSafe(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  return null
}

function parseExpenseJson(raw: string): ExtractedExpenseData {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('No se pudo interpretar la respuesta de la IA como JSON.')
  }

  return {
    monto: parseNumberSafe(parsed.monto),
    fecha: parseStringSafe(parsed.fecha),
    categoria: parseStringSafe(parsed.categoria),
    descripcion: parseStringSafe(parsed.descripcion),
    proveedor: parseStringSafe(parsed.proveedor),
    empleado: parseStringSafe(parsed.empleado),
    referencia: parseStringSafe(parsed.referencia),
    metodo_pago: parseStringSafe(parsed.metodo_pago),
  }
}
