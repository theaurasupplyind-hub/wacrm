import type { VoiceOrderArgs, TextOrderArgs, VoiceOrderResult, ParsedOrder } from './types'
import { transcribeAudio } from './transcribe'
import { parseOrder } from './parse-order'
import { searchOrCreateClient, resolveItems, priceItems, createPresupuesto } from './execute-order'

async function runPipeline(
  parsedOrder: ParsedOrder,
  phone: string,
  commit: boolean,
  transcription: string,
  logs: VoiceOrderResult['logs'],
): Promise<VoiceOrderResult> {
  const client = await searchOrCreateClient(parsedOrder.cliente_nombre, phone, logs)

  const resolvedItems = await resolveItems(parsedOrder.items, logs)

  const pricing = await priceItems(resolvedItems, logs)

  let invoice: { numero: string; id: number } | null = null
  if (commit) {
    invoice = await createPresupuesto(client, pricing.items, logs)
  }

  return {
    transcription,
    parsedOrder,
    resolvedItems,
    client,
    pricing,
    invoice,
    error: null,
    logs,
  }
}

export async function processVoiceOrder(args: VoiceOrderArgs): Promise<VoiceOrderResult> {
  const logs: VoiceOrderResult['logs'] = []

  try {
    const transcription = await transcribeAudio(args.buffer, args.mimeType, logs)
    const parsedOrder = await parseOrder(transcription, args.senderPhone, logs)
    return runPipeline(parsedOrder, args.senderPhone, args.commit, transcription, logs)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logs.push({ step: 'voice_error', data: { error: msg } })
    return {
      transcription: '',
      parsedOrder: null,
      resolvedItems: null,
      client: null,
      pricing: null,
      invoice: null,
      error: msg,
      logs,
    }
  }
}

export async function processTextOrder(args: TextOrderArgs): Promise<VoiceOrderResult> {
  const logs: VoiceOrderResult['logs'] = []

  try {
    const parsedOrder = await parseOrder(args.text, args.senderPhone, logs)
    return runPipeline(parsedOrder, args.senderPhone, args.commit, args.text, logs)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logs.push({ step: 'voice_error', data: { error: msg } })
    return {
      transcription: args.text,
      parsedOrder: null,
      resolvedItems: null,
      client: null,
      pricing: null,
      invoice: null,
      error: msg,
      logs,
    }
  }
}
