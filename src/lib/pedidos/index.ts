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
): Promise<ProcessPedidoResult> {
  const parsed = args.parseFn
    ? await args.parseFn(args.text, existing)
    : await parseOrder(args.text, { context: existing })

  if (parsed.items.length === 0) {
    if (existing) {
      const msg = 'No entendí la corrección. ¿Me la repetís?'
      await sendText(args, msg)
      return { handled: true, text: msg }
    }
    return { handled: false }
  }

  const { refs, rules } = await loadCatalog(args)
  const resolved = resolveItems({ items: parsed.items, refs, rules })
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

  const msg = buildOrderSummary(state)
  await sendText(args, msg)
  return { handled: true, text: msg }
}

async function handlePending(
  args: ProcessPedidoMessageArgs,
  ctx: OrderContext,
): Promise<ProcessPedidoResult> {
  const text = (args.text || '').trim()
  if (!text) return { handled: false }

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
