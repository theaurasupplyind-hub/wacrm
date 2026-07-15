import { NextRequest, NextResponse } from 'next/server'
import { processTextOrder } from '@/lib/voice-orders'
import type { VoiceOrderResult } from '@/lib/voice-orders/types'

export const maxDuration = 120

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      text: string
      phone?: string
      pendingVariantItems?: unknown[]
    }

    if (!body.text || !body.text.trim()) {
      return NextResponse.json({ error: 'El texto es obligatorio' }, { status: 400 })
    }

    const result = await processTextOrder({
      text: body.text,
      senderPhone: body.phone || '1145678901',
      senderName: 'Cliente de prueba',
      commit: false,
      pendingVariantItems: body.pendingVariantItems as VoiceOrderResult['pendingVariantItems'],
    })

    return NextResponse.json(result satisfies VoiceOrderResult)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Error interno: ${msg}`, logs: [] }, { status: 500 })
  }
}
