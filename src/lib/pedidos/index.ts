// Orquestador del flujo de presupuestos por bot (Fase 3.7).
// Firma espejo de `processExpenseMessage`. Flujo "asumir y corregir": nunca
// bloquea con preguntas; asume, muestra supuestos y crea el documento recién
// al confirmar.

import type { SupabaseClient } from '@supabase/supabase-js'
import { engineSendText } from '@/lib/flows/meta-send'
import { getPreciosReferencia, getPricingRules, type InvoiceCreatedResult } from '@/lib/facbal/client'
import type { PrecioReferencia, PricingRule } from '@/lib/precios'
import { parseOrder } from './parse-order'
import { resolveItems } from './resolve-items'
import {
  loadOrderContext,
  saveOrderContext,
  clearOrderContext,
  isOrderContextActive,
} from './context'
import { executePedido } from './execute'
import { sendPedidoReceipt } from './send-receipt'
import { buildOrderSummary, classifyOrderReply } from './summary'
import {
  applyOrderGlossary,
  buildKnownVocab,
  detectUnknownTerms,
  loadGlossary,
  parseGlossaryMeanings,
  upsertGlossary,
} from './glossary'
import { buildBotTrace } from '@/lib/bot-trace/build-trace'
import { recordBotTrace } from '@/lib/bot-trace/record'
import type { OrderContext, ParsedOrder } from './types'

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
  /** Inyección para tests: catálogo. En producción se cargan de FacBal. */
  refs?: PrecioReferencia[]
  rules?: PricingRule[]
  /** Inyección para tests: parseo (evita llamar al LLM). */
  parseFn?: (text: string, context: OrderContext | null) => Promise<ParsedOrder>
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

function buildImageUrl(invoiceId: number): string | undefined {
  const base = (process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL || '').replace(/\/$/, '')
  return base ? `${base}/api/presupuesto-image/${invoiceId}` : undefined
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

async function loadCatalog(
  args: ProcessPedidoMessageArgs,
): Promise<{ refs: PrecioReferencia[]; rules: PricingRule[] }> {
  const refs = args.refs ?? (await getPreciosReferencia())
  const rules = args.rules ?? (await getPricingRules())
  return { refs, rules }
}

async function executeConfirmed(
  args: ProcessPedidoMessageArgs,
  ctx: OrderContext,
): Promise<ProcessPedidoResult> {
  try {
    const result = await executePedido({
      clienteNombre: ctx.clienteNombre,
      items: ctx.items,
      senderPhone: args.senderPhone,
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

  const state: OrderContext = {
    stage: 'confirming',
    items: resolved.items,
    clienteNombre: parsed.cliente || existing?.clienteNombre || null,
    total: resolved.total,
    faltantes: resolved.faltantes,
    notaSupuestos: resolved.notaSupuestos,
  }
  await saveOrderContext(args.db, args.conversationId, state)
  await logOrderDecision(args, state, existing ? 'pedido_correction' : 'pedido_new')

  const msg = buildOrderSummary(state)
  await sendText(args, msg)
  return { handled: true, text: msg }
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

async function handlePending(
  args: ProcessPedidoMessageArgs,
  ctx: OrderContext,
): Promise<ProcessPedidoResult> {
  const text = (args.text || '').trim()
  if (!text) return { handled: false }

  // Estamos esperando la explicación de un término desconocido (glosario).
  if (ctx.awaitingGlossary) {
    return handleGlossaryAnswer(args, ctx)
  }

  // Estábamos esperando el nombre del cliente para confirmar.
  if (ctx.awaitingCliente) {
    const updated: OrderContext = { ...ctx, clienteNombre: text, awaitingCliente: false }
    await saveOrderContext(args.db, args.conversationId, updated)
    const msg = buildOrderSummary(updated)
    await sendText(args, msg)
    return { handled: true, text: msg }
  }

  const reply = classifyOrderReply(text)
  if (reply === 'cancel') {
    await clearOrderContext(args.db, args.conversationId)
    const msg = 'Listo, cancelé el pedido.'
    await sendText(args, msg)
    return { handled: true, text: msg }
  }

  if (reply === 'confirm') {
    if (!ctx.clienteNombre) {
      const updated: OrderContext = { ...ctx, awaitingCliente: true }
      await saveOrderContext(args.db, args.conversationId, updated)
      const msg = '¿A nombre de quién armo el presupuesto?'
      await sendText(args, msg)
      return { handled: true, text: msg }
    }
    return executeConfirmed(args, ctx)
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
