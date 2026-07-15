import type { VoiceOrderArgs, TextOrderArgs, VoiceOrderResult, ParsedOrder, ResolvedItem, PendingInvoice } from './types'
import { transcribeAudio } from './transcribe'
import { parseOrder } from './parse-order'
import { searchOrCreateClient, resolveItems, priceItems, createPresupuesto } from './execute-order'
import { createClient, suggestPrice } from '../facbal/client'

function confirmMessage(invoice: { numero: string }): string {
  return `✅ Presupuesto ${invoice.numero} creado — ya lo ves en el programa`
}

function askConfirmMsg(pricing: { total: number }): string {
  return `💰 Total: $${pricing.total.toLocaleString('es-AR')}\nDecí "confirmar" para guardar el presupuesto`
}

async function runPipeline(
  parsedOrder: ParsedOrder,
  phone: string,
  commit: boolean,
  transcription: string,
  logs: VoiceOrderResult['logs'],
  pendingVariantItems?: ResolvedItem[],
  pendingClientName?: string | null,
  pendingInvoice?: PendingInvoice | null,
): Promise<VoiceOrderResult> {
  // ── Confirmar presupuesto pendiente ──
  if (parsedOrder.tipo === 'respuesta_confirmacion' && pendingInvoice) {
    const { client, resolvedItems, pricing } = pendingInvoice
    const invoice = await createPresupuesto(client, pricing.items, logs)
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

  // ── Respuesta de variante ──
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

    const nombreCliente = pendingClientName || phone
    let clientResult: { id: number | null; nombre: string }
    try {
      clientResult = await createClient({ nombre: nombreCliente, telefono: phone })
    } catch {
      clientResult = { id: null, nombre: nombreCliente }
    }

    const pricing = await priceItems(allResolved, logs)

    if (commit) {
      const invoice = await createPresupuesto(clientResult, pricing.items, logs)
      return {
        transcription, parsedOrder, resolvedItems: allResolved,
        client: clientResult, pricing, invoice, error: null, logs,
      }
    }

    const pi: PendingInvoice = { client: clientResult, resolvedItems: allResolved, pricing }
    return {
      transcription, parsedOrder, resolvedItems: allResolved,
      client: clientResult, pricing, invoice: null, error: askConfirmMsg(pricing),
      pendingInvoice: pi, logs,
    }
  }

  // ── Pedido normal ──
  const client = await searchOrCreateClient(parsedOrder.cliente_nombre ?? phone, phone, logs)
  const resolvedItems = await resolveItems(parsedOrder.items, logs)

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
      transcription, parsedOrder, resolvedItems, client,
      pricing: null, invoice: null,
      error: `Necesito que me aclares la variante para:\n${msgs.join('\n')}`,
      pendingVariantItems: needsVar, pendingClientName: parsedOrder.cliente_nombre,
      logs,
    }
  }

  const pricing = await priceItems(resolvedItems, logs)

  if (commit) {
    const invoice = await createPresupuesto(client, pricing.items, logs)
    return {
      transcription, parsedOrder, resolvedItems, client,
      pricing, invoice, error: null, logs,
    }
  }

  const pi: PendingInvoice = { client, resolvedItems, pricing }
  return {
    transcription, parsedOrder, resolvedItems, client,
    pricing, invoice: null, error: askConfirmMsg(pricing),
    pendingInvoice: pi, logs,
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
      transcription: '', parsedOrder: null, resolvedItems: null,
      client: null, pricing: null, invoice: null, error: msg, logs,
    }
  }
}

export async function processTextOrder(args: TextOrderArgs): Promise<VoiceOrderResult> {
  const logs: VoiceOrderResult['logs'] = []

  try {
    const parsedOrder = await parseOrder(args.text, args.senderPhone, logs)
    return runPipeline(
      parsedOrder, args.senderPhone, args.commit, args.text, logs,
      args.pendingVariantItems, args.pendingClientName, args.pendingInvoice,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logs.push({ step: 'voice_error', data: { error: msg } })
    return {
      transcription: args.text, parsedOrder: null, resolvedItems: null,
      client: null, pricing: null, invoice: null, error: msg, logs,
    }
  }
}
