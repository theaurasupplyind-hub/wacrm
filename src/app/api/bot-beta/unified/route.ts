import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { runUnifiedBotBeta } from '@/lib/bot-beta/unified-handler'
import { transcribeAudio } from '@/lib/voice-orders/transcribe'

export const maxDuration = 60

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get('content-type') || ''

    if (contentType.includes('multipart/form-data')) {
      const formData = await req.formData()
      const file = formData.get('audio') as File | null
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

      const supabase = await createClient()
      const { data: { user } } = await supabase.auth.getUser()
      let accountId: string | null = null
      if (user) {
        const { data: member } = await supabase.from('account_members').select('account_id').eq('user_id', user.id).limit(1).maybeSingle()
        accountId = (member as { account_id: string } | null)?.account_id ?? null
      }

      const result = await runUnifiedBotBeta({ text, accountId, userId: user?.id ?? null, history })
      return NextResponse.json({ ...result, transcription: text })
    }

    const body = (await req.json()) as {
      text?: string
      history?: { role: string; content: string }[]
    }

    if (!body.text || !body.text.trim()) {
      return NextResponse.json({ error: 'El texto es obligatorio' }, { status: 400 })
    }

    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    let accountId: string | null = null
    if (user) {
      const { data: member } = await supabase.from('account_members').select('account_id').eq('user_id', user.id).limit(1).maybeSingle()
      accountId = (member as { account_id: string } | null)?.account_id ?? null
    }

    const result = await runUnifiedBotBeta({
      text: body.text,
      accountId,
      userId: user?.id ?? null,
      history: body.history || [],
    })

    return NextResponse.json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Error interno: ${msg}`, logs: [] }, { status: 500 })
  }
}
