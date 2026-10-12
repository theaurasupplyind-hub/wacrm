// Orquestador del flujo de presupuestos por bot.
// Flujo "asumir y corregir": nunca bloquea con preguntas sobre los ítems; los
// resuelve, y recién al confirmar arma el documento. Además recolecta los datos
// de entrega (cliente, tipo de entrega, fecha, descuento) como en galv2.

import type { SupabaseClient } from '@supabase/supabase-js'
import { engineSendText, engineSendInteractiveButtons } from '@/lib/flows/meta-send'
import type { InteractiveButton } from '@/lib/whatsapp/meta-api'
import {
  getPreciosReferencia,
  getPricingRules,
  findClientMatches,
  type InvoiceCreatedResult,
} from '@/lib/facbal/client'
import type { PrecioReferencia, PricingRule } from '@/lib/precios'
import { parseOrder } from './parse-order'
import { resolveItems } from './resolve-items'
import {
  loadOrderContext,
  saveOrderContext,
  clearOrderContext,
  isOrderContextActive,
} from './context'
import { executePedido, pedidoItemsNeto } from './execute'
import { sendPedidoReceipt } from './send-receipt'
import {
  buildOrderSummary,
  classifyOrderReply,
  classifyEntrega,
  classifyYesNo,
  parseDescuento,
} from './summary'
import { applyOrderGlossary, loadGlossary, parseGlossaryMeanings, upsertGlossary } from './glossary'
import { buildKnownVocab, detectUnknownTerms } from './classify-item'
import { parseDeliveryDate, serializeFechaEntrega, isSkipDate } from './dates'
import { buildBotTrace } from '@/lib/bot-trace/build-trace'
import { recordBotTrace } from '@/lib/bot-trace/record'
import type {
  ClienteCandidato,
  DescuentoState,
  OrderContext,
  ParsedDescuento,
  ParsedOrder,
  TipoEntrega,
} from './types'

export interface ProcessPedidoMessageArgs {
  db: SupabaseClient
  text: string
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  senderPhone: string
  senderName: string
  accessToken: string
  messageId?: string | null
  /** Id del botón interactivo tocado (para tipo de entrega / cliente). */
  interactiveReplyId?: string | null
  /** Inyección para tests: catálogo. En producción se cargan de FacBal. */
  refs?: PrecioReferencia[]
  rules?: PricingRule[]
  /** Inyección para tests: parseo (evita llamar al LLM). */
  parseFn?: (text: string, context: OrderContext | null) => Promise<ParsedOrder>
  /** Inyección para tests: búsqueda de clientes (evita llamar a FacBal). */
  findClientsFn?: (nombre: string, telefono?: string) => Promise<ClienteCandidato[]>
}

export interface ProcessPedidoResult {
  handled: boolean
  text?: string
  createdInvoice?: InvoiceCreatedResult
  imageUrl?: string
  error?: string
  replied?: boolean
}

type RepliablePedidoArgs = ProcessPedidoMessageArgs & { __pedidoReplied?: boolean }

function money(n: number): string {
  return `$${n.toLocaleString('es-AR')}`
}

async function sendText(args: ProcessPedidoMessageArgs, text: string): Promise<void> {
  try {
    await engineSendText({
      accountId: args.accountId,
      userId: args.userId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      text,
    })
    ;(args as RepliablePedidoArgs).__pedidoReplied = true
  } catch (err) {
    console.error('[pedido] send error:', err)
  }
}

async function sendButtons(
  args: ProcessPedidoMessageArgs,
  bodyText: string,
  buttons: InteractiveButton[],
): Promise<void> {
  try {
    await engineSendInteractiveButtons({
      accountId: args.accountId,
      userId: args.userId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      bodyText,
      buttons,
    })
    ;(args as RepliablePedidoArgs).__pedidoReplied = true
  } catch (err) {
    // Fallback: si Meta rechaza los botones, mandamos el texto con opciones.
    console.error('[pedido] fallo el envío de botones, fallback a texto:', err)
    const fallback = `${bodyText}\n\nOpciones: ${buttons.map(b => b.title).join(' / ')}`
    await sendText(args, fallback)
  }
}

function normalizeBaseUrl(raw: string | undefined): string | null {
  const v = (raw || '').trim()
  if (!v) return null
  const withScheme = /^https?:\/\//i.test(v) ? v : `https://${v}`
  return withScheme.replace(/\/+$/, '')
}

function buildImageUrl(invoiceId: number): string | undefined {
  // Meta exige una URL absoluta con esquema; el env puede venir sin "https://".
  // Fallbacks: APP_URL → SITE_URL → VERCEL_PROJECT_PRODUCTION_URL → VERCEL_URL.
  const base =
    normalizeBaseUrl(process.env.NEXT_PUBLIC_APP_URL) ||
    normalizeBaseUrl(process.env.NEXT_PUBLIC_SITE_URL) ||
    normalizeBaseUrl(process.env.VERCEL_PROJECT_PRODUCTION_URL) ||
    normalizeBaseUrl(process.env.VERCEL_URL)
  return base ? `${base}/api/presupuesto-image/${invoiceId}` : undefined
}

function itemsNeto(state: OrderContext): number {
  return pedidoItemsNeto(state.items)
}

/** Recalcula el total aplicando el descuento. */
function withTotal(state: OrderContext): OrderContext {
  const neto = itemsNeto(state)
  const amount = state.descuento?.amount ?? 0
  return { ...state, total: Math.max(0, neto - amount) }
}

function resolveDescuento(pd: ParsedDescuento, base: number): DescuentoState {
  const amount = pd.mode === 'percent' ? Math.round((base * pd.value) / 100) : Math.round(pd.value)
  return { mode: pd.mode, value: pd.value, amount }
}

/** True cuando ya tenemos todos los datos para ejecutar. */
function allCollected(ctx: OrderContext): boolean {
  return (
    !!ctx.clienteNombre &&
    ctx.clienteId !== undefined &&
    !!ctx.tipoEntrega &&
    ctx.fechaEntrega !== undefined &&
    ctx.descuento !== undefined
  )
}

/**
 * Persiste la decisión del pedido (ítems resueltos + supuestos + faltantes) en
 * la traza. El "Asumí" NO va al chat: queda acá para ver la cadena de decisión.
 */
async function logOrderDecision(
  args: ProcessPedidoMessageArgs,
  state: OrderContext,
  reason: string,
): Promise<void> {
  try {
    await recordBotTrace(
      buildBotTrace({
        messageId: args.messageId ?? `pedido-${args.conversationId}-${Date.now()}`,
        producer: 'pedido',
        conversationId: args.conversationId,
        contactId: args.contactId,
        accountId: args.accountId,
        source: 'text',
        rawText: args.text,
        messageType: 'text',
        dispatchedTo: 'pedido',
        dispatchReason: reason,
        logs: [
          {
            step: 'pedido_resolved',
            data: {
              items: state.items,
              notaSupuestos: state.notaSupuestos,
              faltantes: state.faltantes,
              total: state.total,
              clienteNombre: state.clienteNombre,
              tipoEntrega: state.tipoEntrega,
              fechaEntrega: state.fechaEntrega,
              descuento: state.descuento,
            },
          },
        ],
        finalStatus: 'replied',
      }),
    )
  } catch (err) {
    console.error('[pedido] trace log error:', err)
  }
}

/** Registra en la traza si el presupuesto se envió como imagen o cayó a texto. */
async function logPedidoSend(
  args: ProcessPedidoMessageArgs,
  info: { imageUrl?: string; replied: boolean; numeroPresupuesto: string; total: number },
): Promise<void> {
  try {
    await recordBotTrace(
      buildBotTrace({
        messageId: args.messageId ?? `pedido-${args.conversationId}-${Date.now()}`,
        producer: 'pedido',
        conversationId: args.conversationId,
        contactId: args.contactId,
        accountId: args.accountId,
        source: 'text',
        rawText: args.text,
        messageType: 'text',
        dispatchedTo: 'pedido',
        dispatchReason: 'pedido_created',
        logs: [{ step: 'pedido_sent', data: info }],
        finalStatus: info.replied ? 'replied' : 'no_reply',
      }),
    )
  } catch (err) {
    console.error('[pedido] trace send log error:', err)
  }
}

async function loadCatalog(
  args: ProcessPedidoMessageArgs,
): Promise<{ refs: PrecioReferencia[]; rules: PricingRule[] }> {
  const refs = args.refs ?? (await getPreciosReferencia())
  const rules = args.rules ?? (await getPricingRules())
  return { refs, rules }
}

async function searchCandidates(
  args: ProcessPedidoMessageArgs,
  nombre: string,
): Promise<ClienteCandidato[]> {
  try {
    if (args.findClientsFn) return await args.findClientsFn(nombre, args.senderPhone)
    const matches = await findClientMatches(nombre, args.senderPhone)
    return matches.map(m => ({
      id: m.client.id,
      nombre: m.client.nombre,
      telefono: m.client.telefono ?? null,
      score: m.score,
    }))
  } catch (err) {
    console.error('[pedido] búsqueda de clientes falló:', err)
    return []
  }
}

async function saveCtx(args: ProcessPedidoMessageArgs, state: OrderContext): Promise<void> {
  await saveOrderContext(args.db, args.conversationId, state)
}

async function cancelOrder(args: ProcessPedidoMessageArgs): Promise<ProcessPedidoResult> {
  await clearOrderContext(args.db, args.conversationId)
  const msg = 'Listo, cancelé el pedido.'
  await sendText(args, msg)
  return { handled: true, text: msg }
}

/**
 * Avanza la recolección de datos de entrega en orden: cliente → tipo de
 * entrega → fecha → descuento → confirmación. Cada paso solo pregunta lo que
 * falta. `opts.includeSummary` agrega el bloque de ítems a la pregunta (para el
 * primer mensaje tras resolver).
 */
async function advance(
  args: ProcessPedidoMessageArgs,
  state: OrderContext,
  opts: { includeSummary?: boolean } = {},
): Promise<ProcessPedidoResult> {
  const prompt = (text: string): string =>
    opts.includeSummary ? buildOrderSummary(state, { confirm: false, prompt: text }) : text

  // 1. Nombre del cliente.
  const clienteNombre = state.clienteNombre
  if (!clienteNombre) {
    const updated = withTotal({ ...state, awaitingCliente: true })
    await saveCtx(args, updated)
    const q = '¿A nombre de quién armo el presupuesto?'
    await sendText(args, prompt(q))
    return { handled: true, text: prompt(q) }
  }
  state = { ...state, awaitingCliente: false }

  // 2. Confirmar el cliente contra la base (evita duplicados).
  if (state.clienteId === undefined) {
    const matches = await searchCandidates(args, clienteNombre)
    if (matches.length === 0) {
      state = { ...state, clienteId: null, clienteCandidatos: [] }
    } else if (matches.length === 1) {
      const c = matches[0]
      const updated = { ...state, clienteCandidatos: matches, awaitingClienteChoice: true }
      await saveCtx(args, updated)
      const tel = c.telefono ? ` (${c.telefono})` : ''
      const question = prompt(`Encontré un cliente parecido: *${c.nombre}*${tel}. ¿Es ese?`)
      await sendButtons(args, question, [
        { id: 'pedido_cli_ok', title: 'Sí, es' },
        { id: 'pedido_cli_no', title: 'No, es otro' },
      ])
      return { handled: true, text: question }
    } else {
      const updated = { ...state, clienteCandidatos: matches, awaitingClienteChoice: true }
      await saveCtx(args, updated)
      const list = matches
        .map((m, i) => `${i + 1}. ${m.nombre}${m.telefono ? ` (${m.telefono})` : ''}`)
        .join('\n')
      const q = `Encontré varios clientes:\n${list}\n\nRespondé el número, o "otro" para crear uno nuevo.`
      await sendText(args, prompt(q))
      return { handled: true, text: prompt(q) }
    }
  }
  state = { ...state, awaitingClienteChoice: false }

  // 3. Tipo de entrega.
  if (!state.tipoEntrega) {
    const updated = { ...state, awaitingEntrega: true }
    await saveCtx(args, updated)
    const q = prompt('¿Cómo lo entregamos?')
    await sendButtons(args, q, [
      { id: 'pedido_entrega_retira', title: 'Retira' },
      { id: 'pedido_entrega_envio', title: 'Envío' },
      { id: 'pedido_entrega_ret_env', title: 'Ret + Env' },
    ])
    return { handled: true, text: q }
  }
  state = { ...state, awaitingEntrega: false }

  // 4. Fecha de entrega (opcional).
  if (state.fechaEntrega === undefined) {
    const updated = { ...state, awaitingFecha: true }
    await saveCtx(args, updated)
    const q = prompt('¿Fecha de entrega? (ej: "el viernes", "15/11", o "no")')
    await sendText(args, q)
    return { handled: true, text: q }
  }
  state = { ...state, awaitingFecha: false }

  // 5. Descuento (opcional).
  if (state.descuento === undefined) {
    const updated = { ...state, awaitingDescuento: true }
    await saveCtx(args, updated)
    const q = prompt('¿Descuento? Escribí un monto ($), un porcentaje (ej: 10%) o "no".')
    await sendText(args, q)
    return { handled: true, text: q }
  }
  state = { ...state, awaitingDescuento: false }

  // 6. Todo listo → resumen final + confirmación.
  const final = withTotal(state)
  await saveCtx(args, final)
  const msg = buildOrderSummary(final)
  await sendText(args, msg)
  return { handled: true, text: msg }
}

async function executeConfirmed(
  args: ProcessPedidoMessageArgs,
  ctx: OrderContext,
): Promise<ProcessPedidoResult> {
  try {
    const result = await executePedido({
      clienteNombre: ctx.clienteNombre,
      clienteId: ctx.clienteId ?? null,
      items: ctx.items,
      senderPhone: args.senderPhone,
      tipoEntrega: ctx.tipoEntrega,
      fechaEntrega: ctx.fechaEntrega,
      descuento: ctx.descuento ?? null,
    })
    await clearOrderContext(args.db, args.conversationId)

    const lines = [`✅ Presupuesto ${result.numeroPresupuesto} creado.`, `Total: ${money(result.total)}`]
    if (result.faltantes.length > 0) {
      lines.push('')
      lines.push('Quedaron sin cotizar:')
      for (const f of result.faltantes) lines.push(`• ${f.descripcion}`)
    }
    const msg = lines.join('\n')
    const imageUrl = buildImageUrl(result.invoice.id)
    const replied = await sendPedidoReceipt({
      accountId: args.accountId,
      userId: args.userId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      imageUrl,
      caption: msg,
    })
    if (replied) (args as RepliablePedidoArgs).__pedidoReplied = true
    await logPedidoSend(args, {
      imageUrl,
      replied,
      numeroPresupuesto: result.numeroPresupuesto,
      total: result.total,
    })
    return {
      handled: true,
      text: msg,
      createdInvoice: result.invoice,
      imageUrl,
      replied,
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    const msg = 'No pude crear el presupuesto. Reintentá en un rato.'
    await sendText(args, msg)
    return { handled: true, text: msg, error }
  }
}

async function resolveAndSave(
  args: ProcessPedidoMessageArgs,
  existing: OrderContext | null,
  overrideText?: string,
): Promise<ProcessPedidoResult> {
  const text = overrideText ?? args.text
  const parsed = args.parseFn
    ? await args.parseFn(text, existing)
    : await parseOrder(text, { context: existing })

  if (parsed.items.length === 0) {
    if (existing && !overrideText) {
      const msg = 'No entendí la corrección. ¿Me la repetís?'
      await sendText(args, msg)
      return { handled: true, text: msg }
    }
    return { handled: false }
  }

  const { refs, rules } = await loadCatalog(args)
  const glossary = await loadGlossary(args.db, args.accountId)
  const items = applyOrderGlossary(parsed.items, glossary)

  // Términos que el bot no entiende → preguntar y aguardar (glosario general).
  const vocab = buildKnownVocab(refs, rules)
  const unknown = detectUnknownTerms(items, vocab, glossary)
  if (unknown.length > 0) {
    const terms = unknown.map(u => u.term)
    const state: OrderContext = {
      stage: 'confirming',
      items: [],
      clienteNombre: parsed.cliente || existing?.clienteNombre || null,
      total: 0,
      faltantes: [],
      notaSupuestos: [],
      awaitingGlossary: { terms, orderText: text },
    }
    await saveOrderContext(args.db, args.conversationId, state)
    const msg = buildGlossaryQuestion(terms)
    await sendText(args, msg)
    return { handled: true, text: msg }
  }

  const resolved = resolveItems({ items, refs, rules })
  if (resolved.items.length === 0) return { handled: false }

  const nextClienteNombre = parsed.cliente || existing?.clienteNombre || null
  const clienteChanged = !!parsed.cliente && parsed.cliente !== existing?.clienteNombre

  const baseNeto = resolved.total
  let descuento: DescuentoState | null | undefined = existing?.descuento
  if (parsed.descuento) {
    descuento = resolveDescuento(parsed.descuento, baseNeto)
  } else if (descuento && descuento.mode === 'percent') {
    // Los ítems cambiaron: recalculamos el monto del descuento porcentual.
    descuento = { ...descuento, amount: Math.round((baseNeto * descuento.value) / 100) }
  }

  const nextFecha =
    parsed.fechaEntrega != null ? parsed.fechaEntrega : existing?.fechaEntrega

  const state: OrderContext = {
    stage: 'confirming',
    items: resolved.items,
    clienteNombre: nextClienteNombre,
    clienteId: clienteChanged ? undefined : existing?.clienteId,
    clienteCandidatos: clienteChanged ? [] : existing?.clienteCandidatos,
    tipoEntrega: parsed.tipoEntrega ?? existing?.tipoEntrega,
    fechaEntrega: nextFecha,
    descuento,
    total: resolved.total,
    faltantes: resolved.faltantes,
    notaSupuestos: resolved.notaSupuestos,
  }

  await saveCtx(args, state)
  await logOrderDecision(args, state, existing ? 'pedido_correction' : 'pedido_new')

  return advance(args, state, { includeSummary: true })
}

function buildGlossaryQuestion(terms: string[]): string {
  const list = terms.map(t => `"${t}"`).join(', ')
  const plural = terms.length > 1
  return (
    `Antes de cotizar necesito entender ${plural ? 'unos términos' : 'un término'}: ${list}.\n` +
    `¿Qué ${plural ? 'significan' : 'significa'}? Por ejemplo: "es grosor 4" o "es la variante Doble 4cm". ` +
    `Lo guardo para los próximos pedidos.`
  )
}

async function handleGlossaryAnswer(
  args: ProcessPedidoMessageArgs,
  ctx: OrderContext,
): Promise<ProcessPedidoResult> {
  const pending = ctx.awaitingGlossary
  if (!pending) return resolveAndSave(args, ctx)

  const catalog = await loadCatalog(args)
  const interpretations = await parseGlossaryMeanings(pending.terms, args.text, catalog)
  if (interpretations.length === 0) {
    const msg = `No entendí. ${buildGlossaryQuestion(pending.terms)}`
    await sendText(args, msg)
    return { handled: true, text: msg }
  }

  for (const it of interpretations) {
    await upsertGlossary(args.db, args.accountId, {
      termNorm: it.termNorm,
      termDisplay: it.termNorm,
      meaning: it.meaning,
    })
  }

  // Re-resolver el pedido original ahora que el glosario lo entiende.
  return resolveAndSave(args, ctx, pending.orderText)
}

/** Maneja un tap de botón interactivo del flujo de pedidos. */
async function handleButton(
  args: ProcessPedidoMessageArgs,
  ctx: OrderContext,
  buttonId: string,
): Promise<ProcessPedidoResult> {
  if (buttonId === 'pedido_cli_ok') {
    const c = ctx.clienteCandidatos?.[0]
    return advance(args, {
      ...ctx,
      clienteId: c?.id ?? null,
      clienteNombre: c?.nombre ?? ctx.clienteNombre,
      clienteCandidatos: [],
      awaitingClienteChoice: false,
    })
  }
  if (buttonId === 'pedido_cli_no') {
    return advance(args, { ...ctx, clienteId: null, clienteCandidatos: [], awaitingClienteChoice: false })
  }
  const entrega: Record<string, TipoEntrega> = {
    pedido_entrega_retira: 'Retira',
    pedido_entrega_envio: 'Envio',
    pedido_entrega_ret_env: 'Retiro y Envio',
  }
  if (entrega[buttonId]) {
    return advance(args, { ...ctx, tipoEntrega: entrega[buttonId], awaitingEntrega: false })
  }
  return { handled: false }
}

/** Maneja la respuesta de texto cuando mostramos candidatos de cliente. */
async function handleClienteChoiceText(
  args: ProcessPedidoMessageArgs,
  ctx: OrderContext,
  text: string,
): Promise<ProcessPedidoResult> {
  const t = text.trim().toLowerCase()
  if (/cancel/.test(t)) return cancelOrder(args)

  const cands = ctx.clienteCandidatos ?? []
  const reask = async (): Promise<ProcessPedidoResult> => {
    const msg = '¿Es alguno de esos? Respondé el número, "sí" (el primero), o "otro" para crear uno nuevo.'
    await sendText(args, msg)
    return { handled: true, text: msg }
  }

  const num = t.match(/^\s*(\d{1,2})\s*$/)
  if (num) {
    const idx = parseInt(num[1], 10) - 1
    if (idx >= 0 && idx < cands.length) {
      const c = cands[idx]
      return advance(args, {
        ...ctx,
        clienteId: c.id,
        clienteNombre: c.nombre,
        clienteCandidatos: [],
        awaitingClienteChoice: false,
      })
    }
    return reask()
  }

  const yn = classifyYesNo(text)
  if (yn === 'yes' && cands.length >= 1) {
    const c = cands[0]
    return advance(args, {
      ...ctx,
      clienteId: c.id,
      clienteNombre: c.nombre,
      clienteCandidatos: [],
      awaitingClienteChoice: false,
    })
  }
  if (yn === 'no') {
    return advance(args, { ...ctx, clienteId: null, clienteCandidatos: [], awaitingClienteChoice: false })
  }

  // Escribió un nombre nuevo: lo tomamos como cliente (y re-buscamos candidatos).
  if (text.trim().length >= 2) {
    return advance(args, {
      ...ctx,
      clienteNombre: text.trim(),
      clienteId: undefined,
      clienteCandidatos: [],
      awaitingClienteChoice: false,
    })
  }

  return reask()
}

async function handlePending(
  args: ProcessPedidoMessageArgs,
  ctx: OrderContext,
): Promise<ProcessPedidoResult> {
  const buttonId = args.interactiveReplyId || null
  if (buttonId) return handleButton(args, ctx, buttonId)

  const text = (args.text || '').trim()
  if (!text) return { handled: false }

  // Estamos esperando la explicación de un término desconocido (glosario).
  if (ctx.awaitingGlossary) {
    return handleGlossaryAnswer(args, ctx)
  }

  // Estábamos esperando el nombre del cliente.
  if (ctx.awaitingCliente) {
    const reply = classifyOrderReply(text)
    if (reply === 'cancel') return cancelOrder(args)
    if (reply === 'confirm') {
      const msg = 'Necesito el nombre del cliente. ¿A nombre de quién armo el presupuesto?'
      await sendText(args, msg)
      return { handled: true, text: msg }
    }
    return advance(args, {
      ...ctx,
      clienteNombre: text,
      clienteId: undefined,
      clienteCandidatos: [],
      awaitingCliente: false,
    })
  }

  // Elegir entre candidatos de cliente.
  if (ctx.awaitingClienteChoice) {
    return handleClienteChoiceText(args, ctx, text)
  }

  // Tipo de entrega.
  if (ctx.awaitingEntrega) {
    if (classifyOrderReply(text) === 'cancel') return cancelOrder(args)
    const t = classifyEntrega(text)
    if (t) return advance(args, { ...ctx, tipoEntrega: t, awaitingEntrega: false })
    const msg = 'No entendí. ¿Retira, envío, o retiro y envío?'
    await sendText(args, msg)
    return { handled: true, text: msg }
  }

  // Fecha de entrega.
  if (ctx.awaitingFecha) {
    if (isSkipDate(text)) {
      return advance(args, { ...ctx, fechaEntrega: '', awaitingFecha: false })
    }
    if (classifyOrderReply(text) === 'cancel') return cancelOrder(args)
    const parsedDate = parseDeliveryDate(text)
    if (parsedDate) {
      return advance(args, {
        ...ctx,
        fechaEntrega: serializeFechaEntrega(parsedDate),
        awaitingFecha: false,
      })
    }
    const msg = 'No entendí la fecha. Probá "el viernes", "15/11", o "no".'
    await sendText(args, msg)
    return { handled: true, text: msg }
  }

  // Descuento.
  if (ctx.awaitingDescuento) {
    const parsedDesc = parseDescuento(text, itemsNeto(ctx))
    if (parsedDesc === 'skip') {
      return advance(args, { ...ctx, descuento: null, awaitingDescuento: false })
    }
    if (parsedDesc) {
      return advance(args, { ...ctx, descuento: parsedDesc, awaitingDescuento: false })
    }
    if (classifyOrderReply(text) === 'cancel') return cancelOrder(args)
    const msg = 'No entendí. Escribí un monto ($), un porcentaje (10%) o "no".'
    await sendText(args, msg)
    return { handled: true, text: msg }
  }

  const reply = classifyOrderReply(text)
  if (reply === 'cancel') {
    return cancelOrder(args)
  }

  if (reply === 'confirm') {
    if (allCollected(ctx)) return executeConfirmed(args, ctx)
    // Faltan datos de entrega: los pedimos.
    return advance(args, ctx)
  }

  // Cualquier otra cosa es una corrección (agrupada o por ítem).
  return resolveAndSave(args, ctx)
}

export async function processPedidoMessage(
  args: ProcessPedidoMessageArgs,
): Promise<ProcessPedidoResult> {
  ;(args as RepliablePedidoArgs).__pedidoReplied = false
  const ctx = await loadOrderContext(args.db, args.conversationId)
  const result = isOrderContextActive(ctx)
    ? await handlePending(args, ctx as OrderContext)
    : await resolveAndSave(args, null)
  return { ...result, replied: (args as RepliablePedidoArgs).__pedidoReplied }
}

export type { OrderContext, PedidoItem } from './types'
export { buildOrderSummary, classifyOrderReply } from './summary'
export type { PedidoReply } from './summary'
