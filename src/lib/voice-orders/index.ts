import type { VoiceOrderArgs, VoiceOrderResult } from './types'
import { transcribeAudio } from './transcribe'
import { parseOrder } from './parse-order'
import { searchOrCreateClient, priceItems, createPresupuesto } from './execute-order'

export async function processVoiceOrder(args: VoiceOrderArgs): Promise<VoiceOrderResult> {
  const logs: VoiceOrderResult['logs'] = []

  try {
    // ── 1. Transcribe ──
    const transcription = await transcribeAudio(args.buffer, args.mimeType, logs)

    // ── 2. Parse order ──
    const parsedOrder = await parseOrder(transcription, args.senderPhone, logs)

    // ── 3. Search / create client ──
    const client = await searchOrCreateClient(parsedOrder.cliente_nombre, args.senderPhone, logs)

    // ── 4. Price items ──
    const pricing = await priceItems(parsedOrder.items, logs)

    // ── 5. Create presupuesto (only if commit=true) ──
    let invoice: { numero: string; id: number } | null = null
    if (args.commit) {
      invoice = await createPresupuesto(client, pricing.items, logs)
    }

    return {
      transcription,
      parsedOrder,
      client,
      pricing,
      invoice,
      error: null,
      logs,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logs.push({ step: 'voice_error', data: { error: msg } })
    return {
      transcription: '',
      parsedOrder: null,
      client: null,
      pricing: null,
      invoice: null,
      error: msg,
      logs,
    }
  }
}
