/**
 * Cliente de TypeSafe Jev (System One) vía OpenRouter Decisions API.
 *
 * Jev NO genera texto: recibe un `state` y un mapa de preguntas tipadas
 * (`choice` / `noul` / `score`) y devuelve respuestas tipadas con
 * probabilidades calibradas. Se usa como auxiliar de decisión del bot
 * (clasificación de intent + ruteo de pendientes), nunca para redactar.
 *
 * Endpoint de OpenRouter: POST https://openrouter.ai/api/alpha/decisions
 * (distinto de /chat/completions). Usa la misma OPENROUTER_API_KEY.
 *
 * Este módulo no conoce el bot: solo transporta. La interpretación vive en
 * `classify-jev.ts`.
 */

const OPENROUTER_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions'
const DEFAULT_MODEL = 'typesafe/jev-1.13'
const DEFAULT_TIMEOUT_MS = 4000

export type JevChoiceQuestion = {
  type: 'choice'
  instructions: string
  criteria: Record<string, string | null>
}

export type JevNoulQuestion = {
  type: 'noul'
  instructions: string
  criteria?: { true?: string; false?: string }
}

export type JevScoreQuestion = {
  type: 'score'
  instructions: string
  criteria: string[]
}

export type JevQuestion = JevChoiceQuestion | JevNoulQuestion | JevScoreQuestion

export interface JevChoiceAnswer {
  type: 'choice'
  choice: string
  probabilities: Record<string, number>
  confidence: number
}

export interface JevNoulAnswer {
  type: 'noul'
  noul: number
}

export interface JevScoreAnswer {
  type: 'score'
  score: number
  legend: Record<string, string>
  probabilities: Record<string, number>
  confidence: number
}

export type JevAnswer = JevChoiceAnswer | JevNoulAnswer | JevScoreAnswer

export interface JevUsage {
  input_tokens: number
  output_tokens: number
}

export interface JevResult {
  answers: Record<string, JevAnswer>
  usage: JevUsage
}

export interface JevCallArgs {
  state: unknown
  questions: Record<string, JevQuestion>
  model?: string
  timeoutMs?: number
}

/** Master switch. false (default) = Jev no se ejecuta en absoluto. */
export function isJevEnabled(): boolean {
  return process.env.JEV_ENABLED === 'true'
}

/**
 * Modo shadow: corre Jev, guarda su resultado como debug, pero NO cambia
 * el comportamiento (se sigue usando el resultado del LLM). Default true
 * cuando JEV_ENABLED=true, para que activar Jev por error no altere nada.
 */
export function isJevShadow(): boolean {
  return process.env.JEV_SHADOW !== 'false'
}

export function jevModel(): string {
  return process.env.JEV_MODEL?.trim() || DEFAULT_MODEL
}

function jevTimeoutMs(): number {
  const raw = Number(process.env.JEV_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Ejecuta una evaluación Jev. Lanza en error de red/HTTP; el llamador
 * (classify-jev) decide el fallback. Reintenta una vez en 429/529.
 */
export async function callJev(args: JevCallArgs): Promise<JevResult> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set')

  const model = args.model || jevModel()
  const timeout = args.timeoutMs ?? jevTimeoutMs()
  const body = JSON.stringify({
    model,
    state: args.state,
    questions: args.questions,
  })

  const doFetch = async (): Promise<Response> =>
    fetch(OPENROUTER_DECISIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(timeout),
    })

  let res: Response
  try {
    res = await doFetch()
    if (res.status === 429 || res.status === 529) {
      await sleep(400)
      res = await doFetch()
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error('Jev tardó demasiado en responder.')
    }
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Error al contactar Jev (OpenRouter): ${msg}`)
  }

  if (!res.ok) {
    let detail = ''
    try {
      const errBody = (await res.json()) as { error?: { message?: string } | string }
      detail = typeof errBody?.error === 'string' ? errBody.error : errBody?.error?.message || ''
    } catch {
      /* ignore */
    }
    throw new Error(`Jev error ${res.status}${detail ? `: ${detail}` : ''}`)
  }

  const data = (await res.json()) as {
    answers?: Record<string, JevAnswer>
    usage?: { input_tokens?: number; output_tokens?: number }
  }

  if (!data?.answers || typeof data.answers !== 'object') {
    throw new Error('Jev devolvió una respuesta sin "answers".')
  }

  return {
    answers: data.answers,
    usage: {
      input_tokens: data.usage?.input_tokens ?? 0,
      output_tokens: data.usage?.output_tokens ?? 0,
    },
  }
}
