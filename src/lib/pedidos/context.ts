import type { SupabaseClient } from '@supabase/supabase-js'
import type { OrderContext } from './types'

/** Un pedido a medio armar (slots: medida, cliente, entrega…) expira rápido. */
export const PENDING_ORDER_TTL_MS = 30 * 60 * 1000

/**
 * Una cotización ya presentada aguanta 24h: el usuario la retoma a la noche
 * (incidente 1, notas-fallos-reales.md). Los slots siguen en 30 min.
 */
export const QUOTE_TTL_MS = 24 * 3600 * 1000

/**
 * Ventana en la que una cotización VENCIDA todavía se recuerda para ofrecer
 * retomarla (fix #2, notas-fallos-reales.md). Más vieja que esto, se trata
 * como si no hubiera nada.
 */
export const STALE_QUOTE_RECALL_MS = 7 * 24 * 3600 * 1000

export async function loadOrderContext(
  db: SupabaseClient,
  conversationId: string,
): Promise<OrderContext | null> {
  try {
    const { data } = await db
      .from('conversations')
      .select('order_context')
      .eq('id', conversationId)
      .maybeSingle()
    const ctx = data?.order_context as OrderContext | undefined
    if (!ctx || !ctx.stage) return null
    return ctx
  } catch {
    return null
  }
}

export async function saveOrderContext(
  db: SupabaseClient,
  conversationId: string,
  state: OrderContext,
): Promise<void> {
  try {
    await db
      .from('conversations')
      .update({ order_context: { ...state, updatedAt: Date.now() } })
      .eq('id', conversationId)
  } catch (err) {
    console.error('[pedido] save context error:', err)
  }
}

export async function clearOrderContext(db: SupabaseClient, conversationId: string): Promise<void> {
  try {
    await db.from('conversations').update({ order_context: {} }).eq('id', conversationId)
  } catch (err) {
    console.error('[pedido] clear context error:', err)
  }
}

/** True si el pedido pendiente está en etapa de confirmación y no expiró. */
export function isOrderContextActive(ctx: OrderContext | null, now = Date.now()): boolean {
  if (!ctx || ctx.stage !== 'confirming') return false
  if (!ctx.updatedAt) return true
  const ttl = ctx.awaitingQuoteApproval ? QUOTE_TTL_MS : PENDING_ORDER_TTL_MS
  return now - ctx.updatedAt <= ttl
}

/**
 * Cotización vencida pero recordable (fix #2): el comando `cancela` la usa
 * para responder "venció, ¿la armo de nuevo?" en vez de "nada pendiente".
 * Null si no hay nada, si sigue activa o si es demasiado vieja.
 */
export function getStaleQuote(ctx: OrderContext | null, now = Date.now()): OrderContext | null {
  if (!ctx || ctx.stage !== 'confirming') return null
  if (!ctx.updatedAt) return null
  if (isOrderContextActive(ctx, now)) return null
  if (now - ctx.updatedAt > STALE_QUOTE_RECALL_MS) return null
  return ctx
}
