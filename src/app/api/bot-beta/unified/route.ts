import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { runUnifiedBotBeta, resolveBetaAccountId } from '@/lib/bot-beta/unified-handler'
import { transcribeAudio } from '@/lib/audio/transcribe'
import { extractVoucherData } from '@/lib/ai/voucher-extraction'

export const maxDuration = 60

/** Cuenta del usuario: cliente autenticado + fallback service-role por RLS. */
async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  const admin = url && key ? createAdminClient(url, key) : null
  return resolveBetaAccountId({ supabase, admin, userId })
}

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get('content-type') || ''

    if (contentType.includes('multipart/form-data')) {
      const formData = await req.formData()
      const audioFile = formData.get('audio') as File | null
      const voucherFile = (formData.get('file') || formData.get('voucher') || formData.get('image')) as File | null
      const historyRaw = formData.get('history') as string | null
      const captionRaw = (formData.get('caption') || formData.get('text') || '') as string
      const agentMode = formData.get('agentMode') === 'true'
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
        const voucherCaption: string | null = captionRaw?.trim() || null
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
          accountId = await resolveAccountId(supabase, user.id)
        }
        const result = await runUnifiedBotBeta({
          text: textForRouter,
          accountId,
          userId: user?.id ?? null,
          history,
          agentMode,
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
          accountId = await resolveAccountId(supabase, user.id)
        }

        const result = await runUnifiedBotBeta({ text, accountId, userId: user?.id ?? null, history, agentMode })
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
      agentMode?: boolean
    }

    if (!body.text || !body.text.trim()) {
      return NextResponse.json({ error: 'El texto es obligatorio' }, { status: 400 })
    }

    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    let accountId: string | null = null
    if (user) {
      accountId = await resolveAccountId(supabase, user.id)
    }

    const result = await runUnifiedBotBeta({
      text: body.text,
      accountId,
      userId: user?.id ?? null,
      history: body.history || [],
      agentMode: body.agentMode === true,
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
