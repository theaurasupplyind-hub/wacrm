import { NextRequest, NextResponse } from 'next/server'
import { processVoiceOrder } from '@/lib/voice-orders'

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const file = formData.get('audio')
    const phone = (formData.get('phone') as string) || '1145678901'
    const name = (formData.get('name') as string) || 'Cliente de prueba'
    const commit = formData.get('commit') === 'true'

    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: 'Archivo de audio requerido' }, { status: 400 })
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    const mimeType = file.type || 'audio/ogg'

    const result = await processVoiceOrder({
      buffer,
      mimeType,
      senderPhone: phone,
      senderName: name,
      commit,
    })

    return NextResponse.json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Error interno: ${msg}`, logs: [] }, { status: 500 })
  }
}

export const config = {
  api: { bodyParser: false },
}
