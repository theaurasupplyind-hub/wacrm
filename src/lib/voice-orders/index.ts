import type { VoiceOrderArgs, TextOrderArgs, VoiceOrderResult, ParsedOrder, ResolvedItem, PendingInvoice, ClientInfo } from './types'
import { transcribeAudio } from './transcribe'
import { parseOrder } from './parse-order'
import { searchOrCreateClient, resolveItems, priceItems, createPresupuesto } from './execute-order'
import { createClient, suggestPrice } from '../facbal/client'

function askConfirmMsg(pricing: { items: { cantidad: number; categoria: string; medida_solicitada: string; medida_referencia: string; variante: string; precio: number | null }[]; total: number }, clientName: string): string {
  let s = `📋 Presupuesto para ${clientName}\n\n`
  for (const item of pricing.items) {
    if (item.precio != null) {
      const ref = item.medida_referencia && item.medida_referencia !== item.medida_solicitada ? ` (precio de ${item.medida_referencia})` : ''
      s += `✅ ${item.cantidad}x ${item.categoria} ${item.medida_solicitada}${item.categoria === 'BASTIDOR' && item.variante ? ` (${item.variante})` : ''} → $${(item.precio * item.cantidad).toLocaleString('es-AR')}${ref}\n`
    } else {
      s += `❌ ${item.cantidad}x ${item.categoria} ${item.medida_solicitada} → SIN PRECIO\n`
    }
  }
  s += `\n💰 Total: $${pricing.total.toLocaleString('es-AR')}\n\nDecí "confirmar" para guardar o "cancelar" para cancelar`
  return s
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
  // ── Cancelar presupuesto pendiente ──
  if (parsedOrder.tipo === 'respuesta_cancelacion' && pendingInvoice) {
    return {
      transcription, parsedOrder, resolvedItems: null,
      client: null, pricing: null, invoice: null,
      error: '❌ Pedido cancelado',
      logs,
    }
  }

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

  // ── Respuesta de precio para ROLLO (dueño dice precio) ──
  if (pendingVariantItems?.length) {
    const needsPrecio = pendingVariantItems.some(i => i.necesita_precio)
    if (needsPrecio) {
      const price = parsePrecioOwner(transcription || parsedOrder.variante_respuesta || '')
      // También intentar parsear del texto original si parsePrecioOwner falla
      const price2 = parsePrecioOwner(argsText(transcription, parsedOrder))
      const finalPrice = price ?? price2
      if (finalPrice != null && finalPrice > 0) {
        const allResolved: ResolvedItem[] = pendingVariantItems.map(i => ({
          ...i,
          precio_base: i.necesita_precio ? finalPrice : i.precio_base,
          necesita_precio: false,
          faltante: false,
        }))
        const nombreCliente = pendingClientName || phone
        let clientResult: ClientInfo
        try {
          const c = await createClient({ nombre: nombreCliente, telefono: phone })
          clientResult = { id: c.id, nombre: c.nombre, telefono: c.telefono ?? undefined, domicilio: c.domicilio ?? undefined }
        } catch {
          clientResult = { id: null, nombre: nombreCliente, telefono: phone }
        }
        const pricing = await priceItems(allResolved, logs)
        // priceItems ignorará necesita_precio porque ya tiene precio_base, pero forzamos precio manual
        // Si pricing no lo tomó, inyectamos manual
        for (let idx = 0; idx < pricing.items.length; idx++) {
          const r = pendingVariantItems[idx]
          if (r?.necesita_precio) {
            pricing.items[idx].precio = finalPrice
            pricing.items[idx].precio_base = finalPrice
            pricing.items[idx].faltante = false
          }
        }
        pricing.total = pricing.items.reduce((s, it) => s + (it.precio ?? 0) * it.cantidad, 0)
        if (commit) {
          const invoice = await createPresupuesto(clientResult, pricing.items, logs)
          return { transcription, parsedOrder, resolvedItems: allResolved, client: clientResult, pricing, invoice, error: null, logs }
        }
        const pi: PendingInvoice = { client: clientResult, resolvedItems: allResolved, pricing }
        return { transcription, parsedOrder, resolvedItems: allResolved, client: clientResult, pricing, invoice: null, error: askConfirmMsg(pricing, clientResult.nombre), pendingInvoice: pi, logs }
      }
      // Si no es precio, caer al manejo normal de variante (no precio)
    }
  }

  function argsText(t: string, _p: ParsedOrder): string { return t }
  function parsePrecioOwner(text: string): number | null {
    if (!text) return null
    const norm = text.toLowerCase().replace(/\$/g,'').trim()
    // 18 mil, 18k -> 18000
    const milMatch = norm.match(/(\d+(?:[.,]\d+)?)\s*(mil|k)\b/)
    if (milMatch) {
      const n = parseFloat(milMatch[1].replace(',','.'))
      if (!isNaN(n)) return Math.round(n * 1000)
    }
    // número suelto: 180000, 18.000, 18,000
    const numMatch = norm.match(/(\d[\d.,]*)/)
    if (numMatch) {
      const cleaned = numMatch[1].replace(/\./g,'').replace(/,/g,'')
      const n = parseInt(cleaned, 10)
      if (!isNaN(n) && n > 0) return n
    }
    return null
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
    let clientResult: ClientInfo
    try {
      const c = await createClient({ nombre: nombreCliente, telefono: phone })
      clientResult = { id: c.id, nombre: c.nombre, telefono: c.telefono ?? undefined, domicilio: c.domicilio ?? undefined }
    } catch {
      clientResult = { id: null, nombre: nombreCliente, telefono: phone }
    }

    const pricing = await priceItems(allResolved, logs)

    const tienePrecios = pricing.items.some(i => i.precio != null)
    if (!tienePrecios) {
      return {
        transcription, parsedOrder, resolvedItems: allResolved,
        client: clientResult, pricing, invoice: null,
        error: 'No se reconoció ningún producto, no se puede generar el presupuesto',
        logs,
      }
    }

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
      client: clientResult, pricing, invoice: null, error: askConfirmMsg(pricing, clientResult.nombre),
      pendingInvoice: pi, logs,
    }
  }

  // ── Pedido normal ──
  const client = await searchOrCreateClient(parsedOrder.cliente_nombre ?? phone, phone, logs)
  const resolvedItems = await resolveItems(parsedOrder.items, logs, parsedOrder.entidades)

  const needsVar = resolvedItems.filter(i => i.necesita_variante)
  if (needsVar.length > 0) {
    const msgs = needsVar.map(i =>
      `"${i.descripcion}" (${i.categoria} ${i.medida}) — ¿Con tela (Lienzo Profesional) o Sin tela?`
    )
    logs.push({
      step: 'voice_error',
      data: { reason: 'necesita_variante', items: needsVar.map(i => ({ descripcion: i.descripcion, variantes: i.variantes_disponibles, medida: i.medida })) },
    })
    return {
      transcription, parsedOrder, resolvedItems, client,
      pricing: null, invoice: null,
      error: `Necesito que me aclares la variante para:\n${msgs.join('\n')}`,
      pendingVariantItems: needsVar, pendingClientName: parsedOrder.cliente_nombre,
      logs,
    }
  }

  const needsPrecio = resolvedItems.filter(i => i.necesita_precio)
  if (needsPrecio.length > 0) {
    const msgs = needsPrecio.map(i => `"${i.descripcion}" (${i.categoria} ${i.medida})`)
    logs.push({ step: 'voice_error', data: { reason: 'necesita_precio', items: needsPrecio.map(i => ({ descripcion: i.descripcion, medida: i.medida })) } })
    return {
      transcription, parsedOrder, resolvedItems, client,
      pricing: null, invoice: null,
      error: `❓ ${msgs.join(', ')} sin referencia (solo ROLLO DE TELA 2 x 5 $180.000). ¿A qué precio lo facturamos? Decime el precio (ej: 180000 o 18 mil)`,
      pendingVariantItems: needsPrecio, pendingClientName: parsedOrder.cliente_nombre,
      logs,
    }
  }

  const pricing = await priceItems(resolvedItems, logs)

  const tienePrecios = pricing.items.some(i => i.precio != null)
  if (!tienePrecios) {
    return {
      transcription, parsedOrder, resolvedItems, client,
      pricing, invoice: null,
      error: 'No se reconoció ningún producto, no se puede generar el presupuesto',
      logs,
    }
  }

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
    pricing, invoice: null, error: askConfirmMsg(pricing, client.nombre),
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
    const hist = (args as TextOrderArgs & { historyText?: string }).historyText
    const parsedOrder = await parseOrder(args.text, args.senderPhone, logs, hist)
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
