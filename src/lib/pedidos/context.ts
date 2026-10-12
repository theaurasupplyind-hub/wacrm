import type { SupabaseClient } from '@supabase/supabase-js'
import type { OrderContext } from './types'

/** Un pedido pendiente expira si pasó este tiempo sin actividad (30 min). */
export const PENDING_ORDER_TTL_MS = 30 * 60 * 1000

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
  return now - ctx.updatedAt <= PENDING_ORDER_TTL_MS
}
