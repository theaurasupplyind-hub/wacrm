import type { VoiceOrderArgs, TextOrderArgs, VoiceOrderResult, ParsedOrder, ResolvedItem } from './types'
import { transcribeAudio } from './transcribe'
import { parseOrder } from './parse-order'
import { searchOrCreateClient, resolveItems, priceItems, createPresupuesto } from './execute-order'
import { createClient, suggestPrice } from '../facbal/client'

async function runPipeline(
  parsedOrder: ParsedOrder,
  phone: string,
  commit: boolean,
  transcription: string,
  logs: VoiceOrderResult['logs'],
  pendingVariantItems?: ResolvedItem[],
  pendingClientName?: string | null,
): Promise<VoiceOrderResult> {
  // ── Si es respuesta de variante, re-resolver items pendientes ──
  if (parsedOrder.tipo === 'respuesta_variante' && parsedOrder.variante_respuesta && pendingVariantItems?.length) {
    const variant = parsedOrder.variante_respuesta.trim().toLowerCase()
    const allResolved: ResolvedItem[] = []

    for (const item of pendingVariantItems) {
      const nuevaDesc = `${item.descripcion} ${variant}`
      try {
        const result = await suggestPrice(nuevaDesc)
        const sug = result.items?.[0] || result.detalles?.[0]
        if (sug && sug.categoria && sug.precio != null && !sug.faltante) {
          allResolved.push({
            descripcion: item.descripcion,
            cantidad: item.cantidad,
            categoria: sug.categoria,
            medida: item.medida,
            variante: variant,
            precio_base: sug.precio,
            medida_referencia: result.medida_encontrada || item.medida_referencia,
            faltante: false,
          })
        } else {
          allResolved.push({ ...item, variante: variant, faltante: true })
        }
      } catch {
        allResolved.push({ ...item, variante: variant, faltante: true })
      }
    }

    // Usar el nombre pendiente de la orden original
    const nombreCliente = pendingClientName || phone
    let clientResult: { id: number | null; nombre: string }
    try {
      clientResult = await createClient({ nombre: nombreCliente, telefono: phone })
    } catch {
      clientResult = { id: null, nombre: nombreCliente }
    }

    const pricing = await priceItems(allResolved, logs)

    let invoice: { numero: string; id: number } | null = null
    if (commit) {
      invoice = await createPresupuesto(clientResult, pricing.items, logs)
    }

    return {
      transcription,
      parsedOrder,
      resolvedItems: allResolved,
      client: clientResult,
      pricing,
      invoice,
      error: null,
      logs,
    }
  }

  // ── Pedido normal ──
  const client = await searchOrCreateClient(parsedOrder.cliente_nombre ?? phone, phone, logs)
  const resolvedItems = await resolveItems(parsedOrder.items, logs)

  // Mostrar TODOS los items que necesitan variante juntos
  const needsVar = resolvedItems.filter(i => i.necesita_variante)
  if (needsVar.length > 0) {
    const msgs = needsVar.map(i =>
      `"${i.descripcion}" — variantes: ${i.variantes_disponibles?.join(', ') ?? 'varias'}`
    )
    logs.push({
      step: 'voice_error',
      data: { reason: 'necesita_variante', items: needsVar.map(i => ({ descripcion: i.descripcion, variantes: i.variantes_disponibles })) },
    })
    return {
      transcription,
      parsedOrder,
      resolvedItems,
      client,
      pricing: null,
      invoice: null,
      error: `Necesito que me aclares la variante para:\n${msgs.join('\n')}`,
      pendingVariantItems: needsVar,
      pendingClientName: parsedOrder.cliente_nombre,
      logs,
    }
  }

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
    return runPipeline(
      parsedOrder, args.senderPhone, args.commit, args.text, logs,
      args.pendingVariantItems, args.pendingClientName,
    )
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
