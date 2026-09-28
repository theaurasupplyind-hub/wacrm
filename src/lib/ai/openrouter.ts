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

// ─── Tool calling (OpenAI-compatible; usado por el agente del asistente) ───

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_call_id?: string
  name?: string
  tool_calls?: ToolCall[]
}

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface OpenRouterChatResult {
  text: string | null
  toolCalls: ToolCall[]
  finishReason: string
  usage: { prompt_tokens: number; completion_tokens: number }
}

/**
 * Chat completion con soporte de tools. Devuelve texto final O tool calls.
 */
export async function callOpenRouterChat(args: {
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  toolChoice?: 'auto' | 'none'
  model?: string
  maxTokens?: number
  temperature?: number
  timeoutMs?: number
}): Promise<OpenRouterChatResult> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set')

  const model = args.model || DEFAULT_MODEL
  const body: Record<string, unknown> = {
    model,
    messages: args.messages,
    max_tokens: args.maxTokens ?? 700,
    temperature: args.temperature ?? 0.3,
  }
  if (args.tools && args.tools.length > 0) {
    body.tools = args.tools
    body.tool_choice = args.toolChoice ?? 'auto'
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
      signal: AbortSignal.timeout(args.timeoutMs ?? 25_000),
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error('OpenRouter tardó demasiado en responder.')
    }
    throw new Error(`Error al contactar OpenRouter: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!res.ok) {
    let detail = ''
    try {
      const b = (await res.json()) as { error?: { message?: string } }
      detail = b?.error?.message || ''
    } catch { /* ignore */ }
    throw new Error(`OpenRouter error ${res.status}${detail ? `: ${detail}` : ''}`)
  }

  const data = (await res.json()) as {
    choices?: {
      finish_reason?: string
      message?: { content?: string | null; tool_calls?: ToolCall[] }
    }[]
    usage?: { prompt_tokens: number; completion_tokens: number }
  }

  const choice = data?.choices?.[0]
  const message = choice?.message
  const rawCalls = message?.tool_calls ?? []
  const toolCalls = rawCalls.filter(
    (c): c is ToolCall => !!c && typeof c.id === 'string' && !!c.function?.name,
  )

  return {
    text: message?.content?.trim() ? message.content.trim() : null,
    toolCalls,
    finishReason: choice?.finish_reason ?? '',
    usage: {
      prompt_tokens: data.usage?.prompt_tokens ?? 0,
      completion_tokens: data.usage?.completion_tokens ?? 0,
    },
  }
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
