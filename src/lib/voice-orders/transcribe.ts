import type { VoiceOrderLog } from './types'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/audio/transcriptions'
const TIMEOUT_MS = 30_000

export async function transcribeAudio(
  buffer: Buffer,
  mimeType: string,
  logs: VoiceOrderLog[],
): Promise<string> {
  const t0 = Date.now()
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set')

  const uint8 = new Uint8Array(buffer)
  const blob = new Blob([uint8], { type: mimeType })
  const formData = new FormData()
  formData.append('model', 'openai/whisper-1')
  formData.append('file', blob, `audio.${mimeType.split('/')[1] || 'ogg'}`)

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  if (!res.ok) {
    let detail = ''
    try {
      const body = (await res.json()) as { error?: { message?: string } }
      detail = body?.error?.message || ''
    } catch { /* ignore */ }
    throw new Error(`Whisper error ${res.status}${detail ? `: ${detail}` : ''}`)
  }

  const data = (await res.json()) as { text?: string }
  const text = (data?.text || '').trim()
  if (!text) throw new Error('Whisper devolvió respuesta vacía.')

  logs.push({
    step: 'voice_transcribe',
    data: { model: 'openai/whisper-1', text_preview: text.slice(0, 120), duration_ms: Date.now() - t0 },
  })

  return text
}
