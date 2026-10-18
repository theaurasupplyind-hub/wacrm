// Orquestador del flujo de presupuestos por bot.
// Flujo "asumir y corregir": nunca bloquea con preguntas sobre los ítems; los
// resuelve, y recién al confirmar arma el documento. Además recolecta los datos
// de entrega (cliente, tipo de entrega, fecha, descuento) como en galv2.

import type { SupabaseClient } from '@supabase/supabase-js'
import { engineSendText, engineSendInteractiveButtons } from '@/lib/flows/meta-send'
import type { InteractiveButton } from '@/lib/whatsapp/meta-api'
import {
  findClientMatches,
  getClientAddresses,
  type InvoiceCreatedResult,
  type ClientAddress,
} from '@/lib/facbal/client'
import { normalizeText, type PrecioReferencia, type PricingRule } from '@/lib/precios'
import { getVocabulary } from '@/lib/catalog/vocabulary'
import { parseOrder } from './parse-order'
import { comprehendOrder, resolveClientGuess } from './understand'
import type { MissingAttr } from './understand'
import {
  loadOrderContext,
  saveOrderContext,
  clearOrderContext,
  isOrderContextActive,
  isResumableQuote,
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
import {
  detectInlineDefinition,
  loadGlossary,
  normalizeTerm,
  parseGlossaryMeanings,
  stripGlossaryReview,
  upsertGlossary,
  wantsGlossaryReview,
} from './glossary'
import { parseDeliveryDate, serializeFechaEntrega, isSkipDate } from './dates'
import { interpretDeliveryReply } from './interpret-delivery'
import { interpretOrderReply } from './interpret-reply'
import {
  interpretQuoteChanges,
  applyQuoteChanges,
  type QuoteLine,
  type ChangeResult,
} from './interpret-changes'
import { buildKnownVocab, classifyItem } from './classify-item'
import {
  isPhoneLikeClientName,
  isGreetingRecipientName,
  isSenderPhone,
  isSenderPhoneCandidate,
  matchClienteCandidato,
  normalizeClientNameReply,
} from './client-identity'
import { isExplicitBudgetCreationRequest, mentionsOrderItems, looksLikeOrderSlotReply } from './intent'
import { buildBotTrace } from '@/lib/bot-trace/build-trace'
import { recordBotTrace } from '@/lib/bot-trace/record'
import type {
  ClienteCandidato,
  DescuentoState,
  OrderContext,
  ParsedDescuento,
  ParsedOrder,
  ParsedOrderItem,
  PedidoItem,
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
  /** Inyección para tests: interpretación de cambio de línea (evita llamar al LLM). */
  modifyFn?: (text: string, lines: QuoteLine[]) => Promise<ChangeResult>
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

/**
 * Conserva los precios editados a mano (`precioManual`) de una cotización
 * abierta al re-resolver los ítems (agregar un ítem o completar un atributo),
 * para que el catálogo no los pise. `skipIndex` es el ítem que el usuario acaba
 * de completar: ese toma el precio de catálogo.
 */
export function mergePreservedItems(
  next: PedidoItem[],
  prev: PedidoItem[] | undefined | null,
  skipIndex?: number,
): PedidoItem[] {
  if (!prev || prev.length === 0) return next
  return next.map((it, i) => {
    if (skipIndex != null && i === skipIndex) return it
    const p = prev[i]
    // Solo conservamos el precio manual si `prev[i]` es REALMENTE el mismo ítem
    // (misma categoría/medida/variante). Si no, es una línea vieja distinta y
    // pisaría el precio del ítem nuevo por posición (bug real).
    const sameItem =
      p != null &&
      p.categoria === it.categoria &&
      p.medida === it.medida &&
      p.variante === it.variante
    if (!sameItem || !p.precioManual || p.faltante || p.precio_unitario == null) return it
    return { ...it, precio_unitario: p.precio_unitario, faltante: false, precioManual: true }
  })
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
  if (args.refs && args.rules) return { refs: args.refs, rules: args.rules }
  // Catálogo cacheado por cuenta (P0): evita 2 HTTP por request.
  const vocab = await getVocabulary(args.accountId)
  return { refs: args.refs ?? vocab.refs, rules: args.rules ?? vocab.rules }
}

async function searchCandidates(
  args: ProcessPedidoMessageArgs,
  nombre: string,
): Promise<ClienteCandidato[]> {
  try {
    if (isPhoneLikeClientName(nombre, args.senderPhone)) return []
    const candidates = args.findClientsFn
      ? await args.findClientsFn(nombre)
      : (await findClientMatches(nombre)).map(m => ({
          id: m.client.id,
          nombre: m.client.nombre,
          telefono: m.client.telefono ?? null,
          score: m.score,
        }))
    // El número interno identifica al remitente, no al cliente del presupuesto.
    return candidates
      .filter(c => !isSenderPhoneCandidate(c, args.senderPhone))
      .map(c => isSenderPhone(c.telefono, args.senderPhone) ? { ...c, telefono: null } : c)
  } catch (err) {
    console.error('[pedido] búsqueda de clientes falló:', err)
    return []
  }
}

async function saveCtx(args: ProcessPedidoMessageArgs, state: OrderContext): Promise<void> {
  await saveOrderContext(args.db, args.conversationId, state)
}

/** Direcciones del cliente (best-effort; [] si no hay o falla). */
async function loadAddresses(
  args: ProcessPedidoMessageArgs,
  clienteId: number | null | undefined,
): Promise<ClientAddress[]> {
  if (clienteId == null) return []
  try {
    // typeof-guard: en tests el módulo facbal va mockeado sin este export.
    if (typeof getClientAddresses !== 'function') return []
    return (await getClientAddresses(clienteId)).filter((a) => a.address?.trim())
  } catch (err) {
    console.error('[pedido] addresses error:', err instanceof Error ? err.message : String(err))
    return []
  }
}

/**
 * Pregunta combinada de datos de entrega (Caso 3): entrega + fecha +
 * domicilio (si aplica) + descuento en UN mensaje. La respuesta la parsea
 * `handleDatosAnswer` de una vez; lo que falte lo pide `advance`.
 */
async function askDatosCombinados(
  args: ProcessPedidoMessageArgs,
  state: OrderContext,
  opts: { includeSummary?: boolean },
): Promise<ProcessPedidoResult> {
  const prompt = (text: string): string =>
    opts.includeSummary ? buildOrderSummary(state, { confirm: false, prompt: text }) : text
  const addresses = await loadAddresses(args, state.clienteId)
  const missingCliente = !state.clienteNombre
  const lines: string[] = []
  if (missingCliente) {
    lines.push('¿A nombre de quién armo el presupuesto?')
    lines.push('Y decime también:')
  } else {
    lines.push('Para cerrarlo decime todo junto:')
  }
  lines.push('• Entrega: ¿Retira, Envío o Retira y Envío?')
  lines.push('• Fecha: ¿para cuándo? (o "no")')
  if (addresses.length === 0) {
    lines.push('• Dirección (si es envío): ¿a dónde lo mando?')
  } else if (addresses.length === 1) {
    lines.push(`• Dirección: ¿al de siempre (${addresses[0].address})? (o decime otra)`)
  } else {
    lines.push(
      `• Dirección: ¿a cuál? ${addresses.map((a, i) => `${i + 1}) ${a.address}`).join(' ')} (o decime otra)`,
    )
  }
  lines.push('• ¿Descuento? (monto, % o "no")')
  const updated = { ...state, awaitingDatos: true }
  await saveCtx(args, updated)
  const q = prompt(lines.join('\n'))
  await sendText(args, q)
  return { handled: true, text: q }
}

/** Resuelve la respuesta combinada y sigue con lo que falte. */
async function handleDatosAnswer(
  args: ProcessPedidoMessageArgs,
  ctx: OrderContext,
): Promise<ProcessPedidoResult> {
  const text = (args.text || '').trim()
  if (!text) return { handled: false }
  const addresses = await loadAddresses(args, ctx.clienteId)
  const info = await interpretDeliveryReply(
    text,
    addresses.map((a) => ({ address: a.address, is_default: a.is_default })),
  )
  const updated: OrderContext = { ...ctx, awaitingDatos: false }
  // Cliente (si lo dijo en la misma respuesta; puede venir solo "Fede").
  if (info.cliente) {
    const name = normalizeClientNameReply(info.cliente, args.senderPhone) ?? info.cliente.trim()
    updated.clienteNombre = name
    updated.clienteId = undefined
    updated.clienteTelefono = undefined
    updated.clienteCandidatos = []
  } else if (!info.tipoEntrega && !info.fechaRaw && !info.descuento && !info.domicilio) {
    if (isPhoneLikeClientName(text, args.senderPhone)) {
      const msg =
        'Ese es el teléfono desde el que me escribís; no lo voy a guardar como cliente. ¿A nombre de quién armo el presupuesto?'
      await sendText(args, msg)
      return { handled: true, text: msg }
    }
    const asName = normalizeClientNameReply(text, args.senderPhone)
    if (asName) {
      updated.clienteNombre = asName
      updated.clienteId = undefined
      updated.clienteTelefono = undefined
      updated.clienteCandidatos = []
    }
  }
  if (info.tipoEntrega) updated.tipoEntrega = info.tipoEntrega
  if (info.fechaRaw) {
    if (/^no\b/i.test(info.fechaRaw)) {
      updated.fechaEntrega = ''
    } else {
      const parsed = parseDeliveryDate(info.fechaRaw)
      if (parsed) updated.fechaEntrega = serializeFechaEntrega(parsed)
    }
  }
  if (info.descuento === 'no') {
    updated.descuento = null
  } else if (info.descuento) {
    const neto = pedidoItemsNeto(ctx.items)
    const amount =
      info.descuento.mode === 'percent'
        ? Math.round((neto * info.descuento.value) / 100)
        : Math.round(info.descuento.value)
    updated.descuento = { mode: info.descuento.mode, value: info.descuento.value, amount: Math.min(amount, neto) }
  }
  if (info.domicilio) updated.clienteDomicilio = info.domicilio
  return advance(args, updated)
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

  // 1. Cliente y entrega en UNA sola pregunta si falta alguno (menos pasos).
  const clienteNombre = state.clienteNombre
  if (!clienteNombre) {
    return askDatosCombinados(args, { ...state, awaitingCliente: false }, opts)
  }
  state = { ...state, awaitingCliente: false }

  // 2. Confirmar el cliente contra la base (evita duplicados).
  if (state.clienteId === undefined) {
    const matches = await searchCandidates(args, clienteNombre)
    if (matches.length === 0) {
      state = { ...state, clienteId: null, clienteTelefono: null, clienteCandidatos: [] }
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

  // 2b. Datos combinados (Caso 3): si falta entrega+fecha+descuento, UNA sola
  // pregunta en vez de tres turnos. Lo que quede sin decir lo pide advance.
  if (!state.tipoEntrega && state.fechaEntrega === undefined && state.descuento === undefined && !state.awaitingDatos) {
    return askDatosCombinados(args, state, opts)
  }

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

  // 4. Fecha de entrega (opcional): si no la dijo, se asume SIN fecha (no bloquea).
  if (state.fechaEntrega === undefined) state = { ...state, fechaEntrega: '' }
  state = { ...state, awaitingFecha: false }

  // 5. Descuento (opcional): si no lo dijo, se asume SIN descuento.
  if (state.descuento === undefined) state = { ...state, descuento: null }
  state = { ...state, awaitingDescuento: false }

  // 5b. Domicilio: solo si es envío y falta (lo común ya vino combinado).
  if (
    (state.tipoEntrega === 'Envio' || state.tipoEntrega === 'Retiro y Envio') &&
    !state.clienteDomicilio &&
    !state.awaitingDomicilio
  ) {
    const addresses = await loadAddresses(args, state.clienteId)
    const updated = { ...state, awaitingDomicilio: true }
    await saveCtx(args, updated)
    const q =
      addresses.length > 0
        ? prompt(`¿A qué dirección lo enviamos? ${addresses.map((a, i) => `${i + 1}) ${a.address}`).join(' ')} (o decime otra)`)
        : prompt('¿A qué dirección lo enviamos?')
    await sendText(args, q)
    return { handled: true, text: q }
  }
  state = { ...state, awaitingDomicilio: false }

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
      clienteTelefono: ctx.clienteTelefono ?? null,
      clienteDomicilio: ctx.clienteDomicilio ?? null,
      items: ctx.items,
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

  return resolveParsedAndAdvance(args, existing, parsed, text)
}

/**
 * Resuelve y avanza con un pedido ya parseado (sin volver a llamar al parser).
 * Se usa con el mensaje del usuario y también al completar un atributo faltante.
 */
async function resolveParsedAndAdvance(
  args: ProcessPedidoMessageArgs,
  existing: OrderContext | null,
  parsed: ParsedOrder,
  text: string,
  preserveSkip?: number,
): Promise<ProcessPedidoResult> {
  const { refs, rules } = await loadCatalog(args)
  const glossary = await loadGlossary(args.db, args.accountId)
  const { resolved, blockingTerms, missing } = comprehendOrder({
    items: parsed.items,
    refs,
    rules,
    glossary,
  })

  // Términos desconocidos que dejan el producto sin reconocer → preguntar y
  // aprender al glosario. Los cosméticos (color/marca) no interrumpen.
  if (blockingTerms.length > 0) {
    const state: OrderContext = {
      stage: 'confirming',
      items: existing?.items ?? [],
      clienteNombre: resolveClientGuess(parsed.cliente, text, existing?.clienteNombre, args.senderPhone).value,
      total: 0,
      faltantes: [],
      notaSupuestos: [],
      awaitingGlossary: { terms: blockingTerms, orderText: text },
    }
    await saveOrderContext(args.db, args.conversationId, state)
    const msg = buildGlossaryQuestion(blockingTerms)
    await sendText(args, msg)
    return { handled: true, text: msg }
  }

  if (resolved.items.length === 0) return { handled: false }

  // Producto reconocido pero sin la medida/variante → preguntarla antes de cotizar.
  if (missing.length > 0) {
    return askItemAttr(args, {
      missing: missing[0],
      parsed,
      orderText: text,
      awaitingQuoteApproval: false,
      clienteNombre: resolveClientGuess(parsed.cliente, text, existing?.clienteNombre, args.senderPhone).value,
      existingItems: existing?.items,
    })
  }

  const invalidParsedClient = isPhoneLikeClientName(parsed.cliente, args.senderPhone)
  const invalidGreeting = isGreetingRecipientName(parsed.cliente, text)
  const invalidExistingClient = isPhoneLikeClientName(existing?.clienteNombre, args.senderPhone)
  const parsedCliente = invalidParsedClient || invalidGreeting ? null : parsed.cliente
  const existingClienteNombre = invalidExistingClient ? null : existing?.clienteNombre
  const nextClienteNombre = parsedCliente || existingClienteNombre || null
  const clienteChanged = !!parsedCliente && parsedCliente !== existingClienteNombre

  // Conserva los precios editados a mano de la cotización abierta (p. ej. al
  // agregar un ítem o completar la medida de otro).
  const items = mergePreservedItems(resolved.items, existing?.items, preserveSkip)
  const baseNeto = pedidoItemsNeto(items)
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
    items,
    clienteNombre: nextClienteNombre,
    clienteTelefono: clienteChanged || invalidExistingClient ? undefined : existing?.clienteTelefono,
    clienteId: clienteChanged || invalidExistingClient ? undefined : existing?.clienteId,
    clienteCandidatos: clienteChanged || invalidExistingClient ? [] : existing?.clienteCandidatos,
    // Caso 3: SIN defaults. Lo no dicho lo pregunta advance (combinado si
    // falta todo, individual si falta algo). Solo se conserva lo que ya estaba
    // (null = "sin descuento" explícito, se respeta).
    tipoEntrega: parsed.tipoEntrega ?? existing?.tipoEntrega,
    fechaEntrega: nextFecha,
    descuento: descuento,
    total: baseNeto,
    faltantes: resolved.faltantes,
    notaSupuestos: resolved.notaSupuestos,
  }

  await saveCtx(args, state)
  await logOrderDecision(args, state, existing ? 'pedido_correction' : 'pedido_new')

  if ((invalidParsedClient || invalidExistingClient) && !nextClienteNombre) {
    const updated = { ...state, awaitingCliente: true }
    await saveCtx(args, updated)
    const msg = buildOrderSummary(updated, {
      confirm: false,
      prompt: 'Ese es el teléfono desde el que me escribís; no lo voy a guardar como cliente. ¿A nombre de quién armo el presupuesto?',
    })
    await sendText(args, msg)
    return { handled: true, text: msg }
  }

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

function buildItemAttrQuestion(missing: MissingAttr): string {
  const label = `"${missing.term}"`
  if (missing.ask === 'variante') return `¿Qué variante de ${label}?`
  if (missing.options.length > 0) return `¿Qué medida de ${label}?`
  return `¿Qué medida para ${label}? (ej: 60x40)`
}

/** Pregunta el atributo que falta (medida/variante). Botones si hay ≤3 opciones. */
async function askItemAttr(
  args: ProcessPedidoMessageArgs,
  opts: {
    missing: MissingAttr
    parsed: ParsedOrder
    orderText: string
    awaitingQuoteApproval: boolean
    clienteNombre: string | null
    /** Ítems ya resueltos de la cotización abierta (se conservan al completar). */
    existingItems?: PedidoItem[]
  },
): Promise<ProcessPedidoResult> {
  const { missing } = opts
  const state: OrderContext = {
    stage: 'confirming',
    // Conservamos los ítems ya cotizados: al responder el atributo se
    // re-resuelven y `mergePreservedItems` mantiene los precios manuales.
    items: opts.existingItems ?? [],
    clienteNombre: opts.clienteNombre,
    total: 0,
    faltantes: [],
    notaSupuestos: [],
    awaitingQuoteApproval: opts.awaitingQuoteApproval || undefined,
    quoteText: opts.awaitingQuoteApproval ? opts.orderText : undefined,
    awaitingItemAttr: {
      itemIndex: missing.itemIndex,
      ask: missing.ask,
      options: missing.options,
      term: missing.term,
      parsed: opts.parsed,
      orderText: opts.orderText,
    },
  }
  await saveOrderContext(args.db, args.conversationId, state)

  const question = buildItemAttrQuestion(missing)
  if (missing.options.length >= 1 && missing.options.length <= 3) {
    await sendButtons(
      args,
      question,
      missing.options.map((opt, i) => ({ id: `pedido_attr_${i}`, title: opt.slice(0, 20) })),
    )
    return { handled: true, text: question }
  }
  const list =
    missing.options.length > 0
      ? `\n\n${missing.options.map((o, i) => `${i + 1}. ${o}`).join('\n')}\n\nRespondé el número o el valor.`
      : ''
  const msg = question + list
  await sendText(args, msg)
  return { handled: true, text: msg }
}

/** Interpreta la respuesta del usuario al atributo faltante. */
async function handleItemAttrAnswer(
  args: ProcessPedidoMessageArgs,
  ctx: OrderContext,
  chosenOverride?: string,
): Promise<ProcessPedidoResult> {
  const slot = ctx.awaitingItemAttr
  if (!slot) {
    return ctx.awaitingQuoteApproval ? presentQuote(args, args.text, ctx) : resolveAndSave(args, ctx)
  }

  const reask = async (prefix: string): Promise<ProcessPedidoResult> => {
    const msg = `${prefix} ${buildItemAttrQuestion(slot)}`
    await sendText(args, msg)
    return { handled: true, text: msg }
  }

  const text = (chosenOverride ?? args.text ?? '').trim()
  if (!text) return { handled: false }
  if (!chosenOverride && classifyOrderReply(text) === 'cancel') return cancelOrder(args)

  // Elegir el valor: opción (por número o valor) o texto libre.
  let chosen: string | null
  if (slot.options.length > 0) {
    const num = text.match(/^\s*(\d{1,2})\s*$/)
    if (num) {
      const idx = parseInt(num[1], 10) - 1
      chosen = idx >= 0 && idx < slot.options.length ? slot.options[idx] : null
    } else {
      const key = normalizeTerm(text)
      chosen = slot.options.find(o => normalizeTerm(o) === key) ?? null
    }
  } else {
    chosen = text
  }
  if (chosen === null) return reask('No entendí esa opción.')
  if (slot.ask === 'medida' && slot.options.length === 0 && !/\d/.test(chosen)) {
    return handleItemAttrWithoutMeasure(args, ctx, slot, text)
  }

  const items = slot.parsed.items.map((it, i) =>
    i === slot.itemIndex ? { ...it, texto: `${it.texto} ${chosen}`.replace(/\s+/g, ' ').trim() } : it,
  )
  const parsed: ParsedOrder = { ...slot.parsed, items }
  const cleaned: OrderContext = { ...ctx, awaitingItemAttr: null, awaitingGlossary: null }

  if (ctx.awaitingQuoteApproval) {
    return quoteFromParsed(args, slot.orderText, { ...cleaned, quoteText: null }, parsed, slot.itemIndex)
  }
  return resolveParsedAndAdvance(args, cleaned, parsed, slot.orderText, slot.itemIndex)
}

/**
 * Parsea con la inyección de tests si existe (si no, el LLM real). Centraliza
 * el reuso de `parseOrder` para los caminos que completan un atributo.
 */
function parseOrderWith(
  args: ProcessPedidoMessageArgs,
  text: string,
  context: OrderContext | null,
): Promise<ParsedOrder> {
  return args.parseFn ? args.parseFn(text, context) : parseOrder(text, { context })
}

/** Contexto mínimo para reenviar ítems ya parseados a `parseOrder`. */
function parsedItemsAsContext(items: ParsedOrderItem[]): PedidoItem[] {
  return items.map((it) => ({
    cantidad: it.cantidad,
    categoria: 'BASTIDOR',
    medida: null,
    variante: null,
    precio_unitario: it.precio ?? null,
    faltante: it.precio == null,
    descripcion: it.texto,
    regla_aplicada: null,
    libre: it.libre,
  }))
}

/**
 * Responde "sin medida"/"no tiene medida"/una frase que redefine el ítem en la
 * pregunta de medida. Reusa `parseOrder` (CERO parsers nuevos): le envía los
 * ítems actuales como contexto; si el usuario no da una medida, el ítem queda
 * como LÍNEA MANUAL (`libre`) y NO se vuelve a preguntar "Necesito una medida"
 * (regresión R3).
 */
async function handleItemAttrWithoutMeasure(
  args: ProcessPedidoMessageArgs,
  ctx: OrderContext,
  slot: NonNullable<OrderContext['awaitingItemAttr']>,
  text: string,
): Promise<ProcessPedidoResult> {
  const idx = slot.itemIndex >= 0 && slot.itemIndex < slot.parsed.items.length ? slot.itemIndex : 0
  const targetItem = slot.parsed.items[idx]
  // Le pasamos SOLO el ítem objetivo como contexto para que el parser no pueda
  // "perder" los demás ítems del pedido (bug real: devolvía 1 ítem y borraba 7).
  const contexto: OrderContext = {
    ...ctx,
    awaitingItemAttr: null,
    items: targetItem ? parsedItemsAsContext([targetItem]) : [],
  }
  let singleParsed: ParsedOrder
  try {
    singleParsed = await parseOrderWith(args, text, contexto)
  } catch (err) {
    console.error('[pedido] parseOrder (sin medida) error:', err)
    singleParsed = { cliente: null, items: targetItem ? [targetItem] : [] }
  }
  // Si el parser no marcó el ítem objetivo como libre, lo marcamos: es una
  // muestra/producto sin medida que se cotiza a mano.
  const updatedItem: ParsedOrderItem = singleParsed.items[0]
    ? { ...singleParsed.items[0], libre: true }
    : { ...(targetItem ?? { cantidad: 1, texto: slot.term }), libre: true }

  // Reemplazamos SOLO la posición objetivo; los demás ítems quedan intactos.
  const parsed: ParsedOrder = {
    ...slot.parsed,
    items: slot.parsed.items.map((it, i) => (i === idx ? updatedItem : it)),
  }

  const cleaned: OrderContext = { ...ctx, awaitingItemAttr: null, awaitingGlossary: null }
  if (ctx.awaitingQuoteApproval) {
    return quoteFromParsed(args, slot.orderText, { ...cleaned, quoteText: null }, parsed, idx)
  }
  return resolveParsedAndAdvance(args, cleaned, parsed, slot.orderText, idx)
}

async function handleGlossaryAnswer(
  args: ProcessPedidoMessageArgs,
  ctx: OrderContext,
): Promise<ProcessPedidoResult> {
  const pending = ctx.awaitingGlossary
  if (!pending) {
    return ctx.awaitingQuoteApproval ? presentQuote(args, args.text, ctx) : resolveAndSave(args, ctx)
  }

  const catalog = await loadCatalog(args)
  const interpretations = await parseGlossaryMeanings(pending.terms, args.text, catalog)
  if (interpretations.length === 0) {
    // El usuario aclaró que no son términos del catálogo (ej. "no son términos,
    // es un producto que no está en el catálogo, Palos de metal"). No inventamos
    // un alias: marcamos como LIBRES los ítems que contenían esos términos y
    // re-cotizamos como líneas manuales, sin guardar nada en order_glossary.
    return requoteWithFreeTerms(args, ctx, pending.terms, pending.orderText)
  }

  for (const it of interpretations) {
    await upsertGlossary(args.db, args.accountId, {
      termNorm: it.termNorm,
      termDisplay: it.termNorm,
      meaning: it.meaning,
    })
  }

  // Re-resolver el texto original ahora que el glosario lo entiende. Si estábamos
  // en una cotización, volvemos a cotizar; si no, seguimos el flujo de creación.
  if (ctx.awaitingQuoteApproval) {
    return presentQuote(args, pending.orderText, { ...ctx, awaitingGlossary: null, quoteText: null })
  }
  return resolveAndSave(args, ctx, pending.orderText)
}

/** Marca como `libre` los ítems cuyo texto contiene alguno de los términos. */
function markTermsLibre(parsed: ParsedOrder, normTerms: string[]): ParsedOrder {
  if (normTerms.length === 0) return parsed
  return {
    ...parsed,
    items: parsed.items.map((it) => {
      const key = normalizeTerm(it.texto)
      return normTerms.some((t) => t && key.includes(t)) ? { ...it, libre: true } : it
    }),
  }
}

/**
 * El usuario aclaró que los términos del glosario NO son términos de catálogo
 * (producto fuera de catálogo). Marca esos ítems como libres y re-cotiza sin
 * guardar en `order_glossary`. Reusa `parseOrder` (sin parser nuevo).
 */
async function requoteWithFreeTerms(
  args: ProcessPedidoMessageArgs,
  ctx: OrderContext,
  terms: string[],
  orderText: string,
): Promise<ProcessPedidoResult> {
  const normTerms = terms.map(normalizeTerm).filter(Boolean)
  let parsed: ParsedOrder
  try {
    parsed = await parseOrderWith(args, orderText, ctx)
  } catch (err) {
    console.error('[pedido] parseOrder (término libre) error:', err)
    parsed = { cliente: ctx.clienteNombre, items: [] }
  }
  const marked = markTermsLibre(parsed, normTerms)
  if (marked.items.length === 0) {
    // No pudimos reconstruir el pedido: no dejamos mudo, volvemos a preguntar.
    const msg = `No entendí. ${buildGlossaryQuestion(terms)}`
    await sendText(args, msg)
    return { handled: true, text: msg }
  }
  const cleaned: OrderContext = { ...ctx, awaitingGlossary: null }
  if (ctx.awaitingQuoteApproval) {
    return quoteFromParsed(args, orderText, { ...cleaned, quoteText: null }, marked)
  }
  return resolveParsedAndAdvance(args, cleaned, marked, orderText)
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
      clienteTelefono: c?.telefono ?? null,
      clienteCandidatos: [],
      awaitingClienteChoice: false,
    })
  }
  if (buttonId === 'pedido_cli_no') {
    return advance(args, { ...ctx, clienteId: null, clienteTelefono: null, clienteCandidatos: [], awaitingClienteChoice: false })
  }
  // Opción de un atributo faltante (medida/variante) tocada como botón.
  if (buttonId.startsWith('pedido_attr_')) {
    const idx = parseInt(buttonId.slice('pedido_attr_'.length), 10)
    const opt = ctx.awaitingItemAttr?.options?.[idx]
    if (opt != null) return handleItemAttrAnswer(args, ctx, opt)
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
  if (classifyOrderReply(text) === 'cancel') return cancelOrder(args)

  const cands = ctx.clienteCandidatos ?? []
  const reask = async (): Promise<ProcessPedidoResult> => {
    const msg = '¿Es alguno de esos? Respondé el número, "sí" (el primero), o "otro" para crear uno nuevo.'
    await sendText(args, msg)
    return { handled: true, text: msg }
  }

  if (t === 'otro' || t === 'otra') {
    const updated: OrderContext = {
      ...ctx,
      clienteNombre: null,
      clienteId: undefined,
      clienteTelefono: undefined,
      clienteCandidatos: [],
      awaitingClienteChoice: false,
      awaitingCliente: true,
    }
    await saveCtx(args, updated)
    const msg = 'Dale, no voy a vincular esos candidatos. ¿Cuál es el nombre del cliente nuevo?'
    await sendText(args, msg)
    return { handled: true, text: msg }
  }

  if (isPhoneLikeClientName(text, args.senderPhone)) {
    const msg = 'Ese es el teléfono desde el que me escribís; no lo voy a usar como cliente. Respondé el número del cliente, "otro" o "cancelar".'
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
        clienteTelefono: c.telefono,
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
      clienteTelefono: c.telefono,
      clienteCandidatos: [],
      awaitingClienteChoice: false,
    })
  }
  if (yn === 'no') {
    return advance(args, { ...ctx, clienteId: null, clienteTelefono: null, clienteCandidatos: [], awaitingClienteChoice: false })
  }

  // Nombre con typo/parcial contra los candidatos mostrados (R7): "Pachecho"
  // matchea "Cesar Pacheco"; "test de direccion" matchea "Test de direccion 1".
  // Se elige directo sin crear un cliente duplicado ni repetir la lista.
  const candidatoElegido = matchClienteCandidato(text, cands)
  if (candidatoElegido) {
    return advance(args, {
      ...ctx,
      clienteId: candidatoElegido.id,
      clienteNombre: candidatoElegido.nombre,
      clienteTelefono: candidatoElegido.telefono,
      clienteCandidatos: [],
      awaitingClienteChoice: false,
    })
  }

  // Escribió un nombre nuevo: lo tomamos como cliente (y re-buscamos candidatos).
  const nombreNuevo = normalizeClientNameReply(text, args.senderPhone)
  if (nombreNuevo) {
    return advance(args, {
      ...ctx,
      clienteNombre: nombreNuevo,
      clienteId: undefined,
      clienteTelefono: undefined,
      clienteCandidatos: [],
      awaitingClienteChoice: false,
    })
  }

  return reask()
}

async function presentQuote(
  args: ProcessPedidoMessageArgs,
  text: string,
  context: OrderContext | null = null,
): Promise<ProcessPedidoResult> {
  const parsed = args.parseFn
    ? await args.parseFn(text, context)
    : await parseOrder(text, { context })
  return quoteFromParsed(args, text, context, parsed)
}

async function quoteFromParsed(
  args: ProcessPedidoMessageArgs,
  text: string,
  context: OrderContext | null,
  parsed: ParsedOrder,
  preserveSkip?: number,
): Promise<ProcessPedidoResult> {
  const quoteText = context?.quoteText ? `${context.quoteText}\n${text}` : text

  if (parsed.items.length === 0) {
    const msg = context?.awaitingQuoteApproval
      ? 'No actualicé la cotización ni guardé un presupuesto. Si querés crear el presupuesto, respondé "sí"; si querés cambiar el producto, decime cuál.'
      : 'No pude identificar el producto para cotizar. Decime qué producto y medida querés consultar.'
    await sendText(args, msg)
    return { handled: true, text: msg }
  }

  const { refs, rules } = await loadCatalog(args)
  const glossary = await loadGlossary(args.db, args.accountId)
  const { resolved, blockingTerms, missing } = comprehendOrder({ items: parsed.items, refs, rules, glossary })

  if (resolved.items.length === 0) {
    const msg = 'No pude identificar el producto para cotizar. Decime qué producto y medida querés consultar.'
    await sendText(args, msg)
    return { handled: true, text: msg }
  }

  // Términos desconocidos que bloquean la cotización → preguntar y aprender.
  // Guardamos el modo "cotización" para re-cotizar cuando el usuario responda.
  if (blockingTerms.length > 0) {
    const state: OrderContext = {
      stage: 'confirming',
      items: [],
      clienteNombre: context?.clienteNombre ?? null,
      total: 0,
      faltantes: [],
      notaSupuestos: [],
      awaitingQuoteApproval: true,
      quoteText,
      awaitingGlossary: { terms: blockingTerms, orderText: quoteText },
    }
    await saveCtx(args, state)
    const msg = buildGlossaryQuestion(blockingTerms)
    await sendText(args, msg)
    return { handled: true, text: msg }
  }

  // Producto reconocido sin medida/variante → preguntarla (modo cotización).
  if (missing.length > 0) {
    return askItemAttr(args, {
      missing: missing[0],
      parsed,
      orderText: quoteText,
      awaitingQuoteApproval: true,
      clienteNombre: context?.clienteNombre ?? null,
      existingItems: context?.items,
    })
  }

  // El cliente se PROPONE acá (nombre limpio) pero se resuelve recién al crear.
  const clienteNombre = resolveClientGuess(
    parsed.cliente,
    text,
    context?.clienteNombre,
    args.senderPhone,
  ).value

  const items = mergePreservedItems(resolved.items, context?.items, preserveSkip)
  const state: OrderContext = {
    stage: 'confirming',
    items,
    clienteNombre,
    total: pedidoItemsNeto(items),
    faltantes: resolved.faltantes,
    notaSupuestos: resolved.notaSupuestos,
    awaitingQuoteApproval: true,
    quoteText,
  }
  await saveCtx(args, state)
  const msg = buildOrderSummary(state, {
    confirm: false,
    title: 'Cotización estimada:',
    prompt: '¿Querés que la convierta en presupuesto?',
  })
  await sendText(args, msg)
  return { handled: true, text: msg }
}

/**
 * ¿El texto nombra una regla del catálogo? Exige la frase completa del nombre
 * o un matchToken de 4+ letras: evita falsos positivos del matcher por raíz
 * común (p.ej. "cambiale" ⇔ "cambio").
 */
function mentionsKnownRule(text: string, rules: PricingRule[]): boolean {
  const words = new Set(normalizeText(text).split(/[^a-z0-9]+/).filter(Boolean))
  return rules.some((rule) => {
    const nameWords = normalizeText(rule.name).split(/[^a-z0-9]+/).filter(Boolean)
    if (nameWords.length > 0 && nameWords.every((w) => words.has(w))) return true
    return rule.matchTokens.some((tok) => {
      const parts = normalizeText(String(tok)).split(/[^a-z0-9]+/).filter(Boolean)
      return parts.length > 0 && parts.every((w) => w.length >= 4 && words.has(w))
    })
  })
}

async function handleQuoteApproval(
  args: ProcessPedidoMessageArgs,
  ctx: OrderContext,
  text: string,
  opts: { freshFallback?: boolean } = {},
): Promise<ProcessPedidoResult> {
  // Anti-keywords: lo obvio va por listas; lo ambiguo lo entiende el LLM con
  // el contexto de la cotización (nunca keywords nuevas).
  const { decision: reply } = await interpretOrderReply(text, {
    waitingFor: `aprobación de la cotización (total $${ctx.total.toLocaleString('es-AR')}) para crear el presupuesto`,
    itemsText: ctx.items
      .filter((it) => !it.faltante)
      .map((it) => `${it.cantidad}x ${it.descripcion}`)
      .join('; ')
      .slice(0, 300),
  })
  if (reply === 'cancel') {
    // Soft-cancel: NO borramos la cotización; la marcamos descartada para poder
    // retomarla ("perdón, sí, hacelo") dentro del TTL de recall. Se limpia del
    // todo recién si el usuario cancela otra vez sobre la cotización descartada.
    const cancelled: OrderContext = { ...ctx, quoteCancelled: true, awaitingQuoteApproval: false }
    await saveCtx(args, cancelled)
    const msg =
      'Listo. No la guardé ni creé nada. Si la querés, decí "hacé el presupuesto" y la retomo; si no, la dejo.'
    await sendText(args, msg)
    return { handled: true, text: msg }
  }

  if (reply === 'confirm' || isExplicitBudgetCreationRequest(text)) {
    // Ítems "Sin cotizar" (libres) sin precio: preguntar UNA vez antes de crear
    // para que no queden mudos (R7/5.2). Con `awaitingFaltante` ya pedido, un
    // "sí"/"seguí" crea igual (no bloquea en loop).
    const pendientes = ctx.items.filter((it) => it.faltante && it.libre)
    if (pendientes.length > 0 && !ctx.awaitingFaltante) {
      const preguntar: OrderContext = { ...ctx, awaitingFaltante: true }
      await saveCtx(args, preguntar)
      const list = pendientes.map((it) => `• "${it.descripcion}"`).join('\n')
      const msg =
        `Antes de crearlo tenés ítems sin precio:\n${list}\n\n` +
        `Decime a qué precio va cada uno (poné 0 si es gratis) o decí "sacalo". ` +
        `Si querés dejarlos así, respondé "seguí".`
      await sendText(args, msg)
      return { handled: true, text: msg }
    }
    // Caso 3: SIN defaults. Lo no seteado lo pregunta advance (combinado si
    // falta todo, individual si falta algo puntual).
    const readyToCreate: OrderContext = {
      ...ctx,
      awaitingQuoteApproval: false,
      awaitingFaltante: false,
      quoteText: null,
    }
    await saveCtx(args, readyToCreate)
    return advance(args, readyToCreate, { includeSummary: true })
  }

  // Corrección de la cotización abierta: intérprete general de cambios
  // (precio/cantidad/quitar). El LLM solo resuelve a qué línea apuntan; la
  // aritmética es determinística. Lo que no es cambio de línea (agregar ítems,
  // variantes, cliente, entrega) → `none` y sigue el flujo de re-cotización.
  const cotizableItems = ctx.items.filter((it) => !it.faltante)
  const pendingItems = ctx.items.filter((it) => it.faltante)
  const quoteLines: QuoteLine[] = cotizableItems.map((it, i) => ({
    n: i + 1,
    descripcion: it.descripcion,
    cantidad: it.cantidad,
    precio: it.precio_unitario,
  }))
  if (quoteLines.length > 0 || pendingItems.length > 0) {
    const changes: ChangeResult = args.modifyFn
      ? await args.modifyFn(text, quoteLines)
      : await interpretQuoteChanges(text, quoteLines, pendingItems.map((it) => it.descripcion))
    if (changes.kind === 'unsupported') {
      // El intérprete sólo conoce las líneas ya cotizadas: si el texto nombra
      // una regla del catálogo ("es Cambio de Tela", "caja fibro 78 x 56"),
      // re-cotizamos con el flujo normal en vez de dejar el mensaje muerto.
      const { rules } = await loadCatalog(args)
      if (mentionsKnownRule(text, rules)) {
        return presentQuote(args, text, opts.freshFallback ? null : ctx)
      }
      const msg = `No pude aplicar ese cambio (${changes.motivo}). La cotización sigue igual; si querés, decímelo de otra forma o la creamos así.`
      await sendText(args, msg)
      return { handled: true, text: msg }
    }
    if (changes.kind === 'ops') {
      const applied = applyQuoteChanges(ctx.items, changes.ops)
      if ('ambiguous' in applied) {
        const opts = applied.ambiguous.options
          .map((o) => (o.n != null ? `${o.n}) ${o.descripcion}` : `• ${o.descripcion}`))
          .join('\n')
        const msg = `Hay más de un ítem que coincide con "${applied.ambiguous.text}":\n${opts}\n\nDecime el número.`
        await sendText(args, msg)
        return { handled: true, text: msg }
      }
      if ('error' in applied) {
        await sendText(args, `${applied.error} Si querés cambiar otra cosa, decime.`)
        return { handled: true, text: applied.error }
      }
      const neto = pedidoItemsNeto(applied.items)
      const desc = ctx.descuento
      const descAmount = desc
        ? desc.mode === 'percent'
          ? Math.round((neto * desc.value) / 100)
          : Math.min(Math.round(desc.value), neto)
        : 0
      const faltantes = applied.items
        .filter((it) => it.faltante)
        .map((it) => `${it.cantidad > 1 ? `${it.cantidad}× ` : ''}"${it.descripcion}"`)
      const updated: OrderContext = {
        ...ctx,
        items: applied.items,
        faltantes,
        total: neto - descAmount,
        descuento: desc && desc.mode === 'percent' ? { ...desc, amount: descAmount } : desc,
      }
      await saveCtx(args, updated)
      const msg = `${applied.notes.join(' ')}\n\n${buildOrderSummary(updated, {
        confirm: false,
        title: 'Cotización actualizada:',
        prompt: '¿Querés que la convierta en presupuesto?',
      })}`
      await sendText(args, msg)
      return { handled: true, text: msg }
    }
  }
  // Fallback: re-cotizar. `freshFallback` (cotización descartada + pedido nuevo)
  // cotiza desde cero, sin concatenar el texto ni los ítems anteriores.
  return presentQuote(args, text, opts.freshFallback ? null : ctx)
}

// "Seguí"/"así está bien" en la pregunta de ítems sin precio → crear con lo que
// hay (los ítems libres quedan fuera del total, como "Sin cotizar").
const FALTANTE_CONTINUE_RE =
  /\b(?:segu[ií]|seguir|continuar|contin[uú]a|dale|ok|listo|dejal[oa]s?|as[ií] nomas|as[ií] est[aá] bien|creal[oa]|hacel[oa]|con eso|sin precio|ninguno|ninguna|nada|no importa)\b/i

/**
 * Respuesta a "ítems sin precio antes de crear". "Seguí"/"sí" crea igual; un
 * precio o "sacalo" lo resuelve el intérprete de cambios de la cotización.
 */
async function handleFaltanteAnswer(
  args: ProcessPedidoMessageArgs,
  ctx: OrderContext,
  text: string,
): Promise<ProcessPedidoResult> {
  const t = (text || '').trim()
  if (!t) return { handled: false }
  if (classifyOrderReply(t) === 'cancel') return cancelOrder(args)

  const tienePrecio = /\d/.test(t)
  if (!tienePrecio && FALTANTE_CONTINUE_RE.test(t)) {
    const ready: OrderContext = { ...ctx, awaitingFaltante: false, awaitingQuoteApproval: false, quoteText: null }
    await saveCtx(args, ready)
    return advance(args, ready, { includeSummary: true })
  }

  // Precio / "sacalo": reusar el flujo normal de la cotización abierta.
  return handleQuoteApproval(args, { ...ctx, awaitingFaltante: false }, t)
}

/**
 * Cotización descartada (soft-cancel). El usuario puede retomarla, cancelarla
 * del todo, o pedir un cambio. Nunca se pierde: los ítems quedaron guardados.
 */
async function handleCancelledQuote(
  args: ProcessPedidoMessageArgs,
  ctx: OrderContext,
  text: string,
): Promise<ProcessPedidoResult> {
  const { decision } = await interpretOrderReply(text, {
    waitingFor: `una cotización descartada (total $${ctx.total.toLocaleString('es-AR')}); el usuario puede retomarla ("hacelo"), dejar de lado de nuevo, o pedir un cambio`,
    itemsText: ctx.items
      .filter((it) => !it.faltante)
      .map((it) => `${it.cantidad}x ${it.descripcion}`)
      .join('; ')
      .slice(0, 300),
  })

  // Cancelar de nuevo → descartar del todo.
  if (decision === 'cancel') {
    await clearOrderContext(args.db, args.conversationId)
    const msg = 'Listo, la descarté del todo.'
    await sendText(args, msg)
    return { handled: true, text: msg }
  }

  // Retomar: equivale a aprobar la cotización (mismos pasos de entrega/cliente).
  if (decision === 'confirm' || isExplicitBudgetCreationRequest(text)) {
    const ready: OrderContext = {
      ...ctx,
      quoteCancelled: false,
      awaitingQuoteApproval: false,
      quoteText: null,
    }
    await saveCtx(args, ready)
    return advance(args, ready, { includeSummary: true })
  }

  // El mensaje trae productos/medidas: puede ser un CAMBIO sobre la cotización
  // descartada (precio/cantidad/quitar/renombrar) o un PEDIDO NUEVO. Lo decide
  // el intérprete de cambios: con `ops` se aplica sobre la cotización; con
  // `none` es un pedido nuevo y se cotiza DESDE CERO (sin concatenar el texto ni
  // arrastrar ítems/cliente). Así "cambiar el pedido, les paso el nuevo: 240x120"
  // no se fusiona con la cotización cancelada (regresión c9d6f97/R1).
  if (mentionsOrderItems(text)) {
    const reopened: OrderContext = { ...ctx, quoteCancelled: false, awaitingQuoteApproval: true }
    await saveCtx(args, reopened)
    return handleQuoteApproval(args, reopened, text, { freshFallback: true })
  }

  // Respuesta a un slot de entrega/cliente sobre la cotización descartada
  // ("el cliente es Federico, es envío"): la retomamos y aplicamos los datos.
  if (looksLikeOrderSlotReply(text)) {
    const reopened: OrderContext = { ...ctx, quoteCancelled: false, awaitingQuoteApproval: false }
    await saveCtx(args, reopened)
    return handleDatosAnswer(args, reopened)
  }

  // Un cambio puntual sobre la cotización (precio/cantidad) → reabrir y pasar
  // por el flujo normal, sin perder los ítems.
  if (/\d/.test(text)) {
    const reopened: OrderContext = { ...ctx, quoteCancelled: false, awaitingQuoteApproval: true }
    await saveCtx(args, reopened)
    return handleQuoteApproval(args, reopened, text)
  }

  // Otra cosa: no secuestramos; recordamos la cotización descartada y dejamos
  // que el usuario decida (el ruteo pudo haberla traído por una respuesta corta).
  const msg = buildOrderSummary(ctx, {
    confirm: false,
    title: 'Cotización descartada:',
    prompt: 'Si la querés, decí "hacela presupuesto"; si no, la dejo.',
  })
  await sendText(args, msg)
  return { handled: true, text: msg }
}

async function handlePending(
  args: ProcessPedidoMessageArgs,
  ctx: OrderContext,
): Promise<ProcessPedidoResult> {
  const buttonId = args.interactiveReplyId || null
  if (buttonId) return handleButton(args, ctx, buttonId)

  const text = (args.text || '').trim()
  if (!text) return { handled: false }

  // Estamos esperando la explicación de un término desconocido (glosario). Va
  // antes de la cotización porque una cotización puede estar esperando glosario.
  if (ctx.awaitingGlossary) {
    return handleGlossaryAnswer(args, ctx)
  }

  // Esperando la medida/variante de un ítem reconocido (también antes de cotizar).
  if (ctx.awaitingItemAttr) {
    return handleItemAttrAnswer(args, ctx)
  }

  // Respuesta combinada de datos de entrega (Caso 3).
  if (ctx.awaitingDatos) {
    return handleDatosAnswer(args, ctx)
  }

  // Solo el domicilio (envío sin dirección).
  if (ctx.awaitingDomicilio) {
    const domicilio = text.trim()
    if (!domicilio) return { handled: false }
    return advance(args, { ...ctx, clienteDomicilio: domicilio, awaitingDomicilio: false })
  }

  // Cotización descartada (soft-cancel): retomar / descartar del todo / corregir.
  if (ctx.quoteCancelled) {
    return handleCancelledQuote(args, ctx, text)
  }

  // Ítems sin precio antes de crear (preguntados en la cotización abierta).
  if (ctx.awaitingFaltante) {
    return handleFaltanteAnswer(args, ctx, text)
  }

  if (ctx.awaitingQuoteApproval) {
    return handleQuoteApproval(args, ctx, text)
  }

  if (ctx.awaitingOrderItems) {
    if (classifyOrderReply(text) === 'cancel') return cancelOrder(args)
    const result = await resolveAndSave(args, ctx, text)
    if (result.handled) return result
    const msg = 'No pude identificar los productos o medidas. Escribilos, por ejemplo: "2 bastidores 60x40 sin tela".'
    await sendText(args, msg)
    return { handled: true, text: msg }
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
    if (mentionsOrderItems(text)) {
      // A correction containing product/measure data is not a client name.
      return resolveAndSave(args, ctx, text)
    }
    if (isPhoneLikeClientName(text, args.senderPhone)) {
      const msg = 'Ese es el teléfono desde el que me escribís; no lo voy a guardar como cliente. Decime el nombre del cliente.'
      await sendText(args, msg)
      return { handled: true, text: msg }
    }
    const nombreCliente = normalizeClientNameReply(text, args.senderPhone)
    if (!nombreCliente) {
      const msg = 'Todavía no guardé el presupuesto. Necesito el nombre del cliente; si querés cancelar, decí "cancelar".'
      await sendText(args, msg)
      return { handled: true, text: msg }
    }
    return advance(args, {
      ...ctx,
      clienteNombre: nombreCliente,
      clienteId: undefined,
      clienteTelefono: undefined,
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

  const { decision: reply } = await interpretOrderReply(text, {
    waitingFor: 'respuesta pendiente del presupuesto (confirmar, cancelar o corregir)',
    itemsText: ctx.items
      .filter((it) => !it.faltante)
      .map((it) => `${it.cantidad}x ${it.descripcion}`)
      .join('; ')
      .slice(0, 300),
  })
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

/**
 * P2 — Glosario "en línea": aprende definiciones ("moldura significa grosor") y
 * reprocesa el pedido pendiente cuando el usuario pide "revisá el glosario".
 * Devuelve un resultado si manejó el mensaje; null para seguir el flujo normal.
 */
async function tryGlossaryAction(
  args: ProcessPedidoMessageArgs,
  ctx: OrderContext | null,
  active: boolean,
): Promise<ProcessPedidoResult | null> {
  const raw = (args.text || '').trim()
  if (!raw) return null
  const review = wantsGlossaryReview(raw)
  const inline = detectInlineDefinition(raw)
  if (!review && !inline) return null

  const { refs, rules } = await loadCatalog(args)
  let learned = false

  if (inline) {
    const vocab = buildKnownVocab(refs, rules)
    const unknown = classifyItem(inline.term, vocab).unknownTerms.length > 0
    if (unknown) {
      const interpretations = await parseGlossaryMeanings([inline.term], raw, { refs, rules })
      for (const it of interpretations) {
        await upsertGlossary(args.db, args.accountId, {
          termNorm: it.termNorm,
          termDisplay: it.termNorm,
          meaning: it.meaning,
        })
        learned = true
      }
    }
  }

  // Reprocesar el pedido pendiente con el glosario vigente.
  if (active && ctx) {
    if (ctx.awaitingQuoteApproval && ctx.quoteText) {
      return presentQuote(args, ctx.quoteText, {
        ...ctx,
        awaitingQuoteApproval: true,
        quoteText: null,
        awaitingItemAttr: null,
        awaitingGlossary: null,
      })
    }
    if (ctx.items.length > 0) {
      const parsed: ParsedOrder = {
        cliente: ctx.clienteNombre,
        items: ctx.items.map(it => ({ cantidad: it.cantidad, texto: it.descripcion })),
      }
      return resolveParsedAndAdvance(args, ctx, parsed, raw)
    }
  }

  // El mismo mensaje trae un pedido además de la definición.
  const orderPart = inline ? inline.cleaned : stripGlossaryReview(raw)
  if (orderPart && mentionsOrderItems(orderPart)) {
    return presentQuote(args, orderPart, null)
  }

  const msg = learned
    ? 'Listo, lo guardé en el glosario para los próximos pedidos.'
    : 'No hay un pedido abierto para revisar. Decime el pedido y lo cotizo con el glosario.'
  await sendText(args, msg)
  return { handled: true, text: msg }
}

export async function processPedidoMessage(
  args: ProcessPedidoMessageArgs,
): Promise<ProcessPedidoResult> {
  ;(args as RepliablePedidoArgs).__pedidoReplied = false
  const ctx = await loadOrderContext(args.db, args.conversationId)
  const active = isOrderContextActive(ctx)

  // P2: "revisá el glosario" / definiciones en línea.
  const glossaryAction = await tryGlossaryAction(args, active ? (ctx as OrderContext) : null, active)
  if (glossaryAction) {
    return { ...glossaryAction, replied: (args as RepliablePedidoArgs).__pedidoReplied }
  }

  let result: ProcessPedidoResult
  if (active || isResumableQuote(ctx)) {
    result = await handlePending(args, ctx as OrderContext)
  } else if (isExplicitBudgetCreationRequest(args.text)) {
    result = await resolveAndSave(args, null)
    if (!result.handled) {
      await saveCtx(args, {
        stage: 'confirming',
        items: [],
        clienteNombre: null,
        total: 0,
        faltantes: [],
        notaSupuestos: [],
        awaitingOrderItems: true,
      })
      const msg = 'Claro, ¿qué productos y medidas incluyo en el presupuesto?'
      await sendText(args, msg)
      result = { handled: true, text: msg }
    }
  } else {
    result = await presentQuote(args, args.text)
  }
  return { ...result, replied: (args as RepliablePedidoArgs).__pedidoReplied }
}

export type { OrderContext, PedidoItem } from './types'
export { buildOrderSummary, classifyOrderReply } from './summary'
export type { PedidoReply } from './summary'
