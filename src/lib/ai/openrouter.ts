const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const TIMEOUT_MS = 20_000
const DEFAULT_MODEL = 'google/gemini-2.5-flash-lite'

export interface OpenRouterCallArgs {
  systemPrompt: string
  userMessage: string
  jsonMode?: boolean
  model?: string
  maxTokens?: number
  temperature?: number
}

export interface OpenRouterResult {
  text: string
  usage: { prompt_tokens: number; completion_tokens: number }
}

export async function callOpenRouter(args: OpenRouterCallArgs): Promise<OpenRouterResult> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set')

  const model = args.model || DEFAULT_MODEL
  const temperature = args.temperature ?? 0.1
  const maxTokens = args.maxTokens ?? 512

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: args.systemPrompt },
      { role: 'user', content: args.userMessage },
    ],
    max_tokens: maxTokens,
    temperature,
  }

  if (args.jsonMode) {
    body.response_format = { type: 'json_object' }
  }

  let res: Response
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
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
    } catch { /* ignore */ }
    throw new Error(`OpenRouter error ${res.status}${detail ? `: ${detail}` : ''}`)
  }

  const data = await res.json() as {
    choices?: { message?: { content?: string } }[]
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
  }

  const text = data?.choices?.[0]?.message?.content
  if (!text || !text.trim()) throw new Error('OpenRouter devolvió respuesta vacía.')

  return {
    text: text.trim(),
    usage: {
      prompt_tokens: data.usage?.prompt_tokens ?? 0,
      completion_tokens: data.usage?.completion_tokens ?? 0,
    },
  }
}
