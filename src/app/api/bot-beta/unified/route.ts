import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { runUnifiedBotBeta } from '@/lib/bot-beta/unified-handler'
import { transcribeAudio } from '@/lib/voice-orders/transcribe'
import { extractVoucherData } from '@/lib/ai/voucher-extraction'

export const maxDuration = 60

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get('content-type') || ''

    if (contentType.includes('multipart/form-data')) {
      const formData = await req.formData()
      const audioFile = formData.get('audio') as File | null
      const voucherFile = (formData.get('file') || formData.get('voucher') || formData.get('image')) as File | null
      const historyRaw = formData.get('history') as string | null
      const captionRaw = (formData.get('caption') || formData.get('text') || '') as string
      let history: { role: string; content: string }[] = []
      if (historyRaw) {
        try {
          history = JSON.parse(historyRaw)
        } catch {
          history = []
        }
      }

      // Voucher image+caption (dummy-only: single message imagen+texto, amount = extractedAmount sole)
      if (voucherFile && voucherFile instanceof File) {
        const buffer = Buffer.from(await voucherFile.arrayBuffer())
        const mimeType = voucherFile.type || 'image/jpeg'
        const base64 = buffer.toString('base64')
        let extractedAmount: number | null = null
        let extractedFecha: string | null = null
        let voucherCaption: string | null = captionRaw?.trim() || null
        try {
          const extracted = await extractVoucherData({ base64, mimeType })
          extractedAmount = extracted.monto
          extractedFecha = extracted.fecha
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return NextResponse.json({ error: `No se pudo leer el voucher: ${msg}`, logs: [] }, { status: 500 })
        }
        const textForRouter = voucherCaption || `voucher $${extractedAmount ?? ''}`.trim()
        const supabase = await createClient()
        const { data: { user } } = await supabase.auth.getUser()
        let accountId: string | null = null
        if (user) {
          const { data: member } = await supabase.from('account_members').select('account_id').eq('user_id', user.id).limit(1).maybeSingle()
          accountId = (member as { account_id: string } | null)?.account_id ?? null
        }
        const result = await runUnifiedBotBeta({
          text: textForRouter,
          accountId,
          userId: user?.id ?? null,
          history,
          voucherCaption,
          voucherExtractedAmount: extractedAmount,
          voucherExtractedFecha: extractedFecha,
        })
        return NextResponse.json({ ...result, extractedAmount, extractedFecha, caption: voucherCaption })
      }

      if (audioFile && audioFile instanceof File) {
        const buffer = Buffer.from(await audioFile.arrayBuffer())
        const mimeType = audioFile.type || 'audio/ogg'
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

      return NextResponse.json({ error: 'Archivo de audio o voucher requerido' }, { status: 400 })
    }

    const body = (await req.json()) as {
      text?: string
      history?: { role: string; content: string }[]
      voucherCaption?: string | null
      voucherExtractedAmount?: number | null
      voucherExtractedFecha?: string | null
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
      voucherCaption: body.voucherCaption ?? null,
      voucherExtractedAmount: body.voucherExtractedAmount ?? null,
      voucherExtractedFecha: body.voucherExtractedFecha ?? null,
    })

    return NextResponse.json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Error interno: ${msg}`, logs: [] }, { status: 500 })
  }
}
