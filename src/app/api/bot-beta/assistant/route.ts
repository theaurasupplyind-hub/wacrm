import { NextRequest, NextResponse } from 'next/server'
import { runAssistant } from '@/lib/bot-assistant/orchestrator'
import { transcribeAudio } from '@/lib/voice-orders/transcribe'

export const maxDuration = 60

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get('content-type') || ''

    // Audio via FormData: transcribe with Whisper then run orchestrator
    if (contentType.includes('multipart/form-data')) {
      const formData = await req.formData()
      const file = formData.get('audio')
      const phone = (formData.get('phone') as string) || '1145678901'
      const historyRaw = formData.get('history') as string | null
      let history: { role: string; content: string }[] = []
      if (historyRaw) {
        try {
          history = JSON.parse(historyRaw)
        } catch {
          history = []
        }
      }
      if (!file || !(file instanceof File)) {
        return NextResponse.json({ error: 'Archivo de audio requerido' }, { status: 400 })
      }
      const buffer = Buffer.from(await file.arrayBuffer())
      const mimeType = file.type || 'audio/ogg'
      const logs: { step: string; data: unknown }[] = []
      let text: string
      try {
        text = await transcribeAudio(buffer, mimeType, logs as never)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return NextResponse.json({ error: msg, logs }, { status: 500 })
      }
      const result = await runAssistant({ text, phone, history })
      return NextResponse.json({ ...result, transcription: text })
    }

    const body = (await req.json()) as {
      text?: string
      phone?: string
      history?: { role: string; content: string }[]
      pendingState?: unknown
    }

    if (!body.text || !body.text.trim()) {
      return NextResponse.json({ error: 'El texto es obligatorio' }, { status: 400 })
    }

    const result = await runAssistant({
      text: body.text,
      phone: body.phone || '1145678901',
      history: body.history || [],
      pendingState: body.pendingState,
    })

    return NextResponse.json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Error interno: ${msg}`, logs: [] }, { status: 500 })
  }
}
