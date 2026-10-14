/**
 * Comando de contexto user-facing.
 *
 * Reemplaza al comando secreto de reset. El usuario final solo tiene:
 *  - "cancelar" / "olvidalo" / "mejor no" / "después" ... → descarta lo
 *    pendiente. Si no hay nada pendiente, no rompe nada (limpieza silenciosa).
 *  - "reiniciar" / "empezar de nuevo" / "borrar todo" / "salir" → limpia TODO.
 *
 * Se evalúa ANTES de la extracción/ruteo para que ningún otro handler (ni el
 * asistente) conteste de más. "no" pelado NO es comando: lo resuelven los
 * flujos por dominio (confirms de gasto/voucher).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { clearVoucherContext } from '@/lib/ai/voucher-context'
import { clearExpenseContext } from '@/lib/expenses/context'
import { clearAttendanceContext } from '@/lib/attendance/context'
import { clearClarifyContext } from '@/lib/bot-llm/clarify-context'
import { clearOrderContext } from '@/lib/pedidos/context'
import { isDismissCommand } from '@/lib/bot-llm/reply-intent'

export type ContextCommand = 'cancel_active' | 'reset_all' | null

const RESET_RE = /^(reiniciar|reinicia|reinicio|empezar de nuevo|empezar de cero|arrancar de nuevo|arrancar de cero|borrar todo|borra todo|resetear|reset|olvida todo|olvid[aá]te de todo|salir|chau bot|jesusdanielllavesecreta)[.!]*$/i

export function classifyContextCommand(text: string): ContextCommand {
  const t = (text || '').trim()
  if (!t) return null
  if (RESET_RE.test(t)) return 'reset_all'
  // Comando global de descarte: definición única en bot-llm/reply-intent.ts
  // (fix #4). Incluye diferir/omitir ("después", "saltar") que dentro de un
  // flujo no cancelan sino que siguen otro camino.
  if (isDismissCommand(t)) return 'cancel_active'
  return null
}

export interface ActiveContexts {
  expense?: boolean
  attendance?: boolean
  voucher?: boolean
  clarify?: boolean
  order?: boolean
}

export interface ContextCommandResult {
  handled: boolean
  reply?: string
}

/** Cotización vencida pero recordable (ver `getStaleQuote` en pedidos/context). */
export interface StaleQuoteInfo {
  total?: number | null
  items?: number
}

/**
 * Aplica el comando. `cancel_active` descarta solo lo pendiente; si no hay
 * nada activo pero hay una cotización vencida recordable, la menciona y ofrece
 * re-armarla en vez de decir "nada pendiente" (fix #2, notas-fallos-reales.md).
 * `reset_all` limpia todo.
 */
export async function handleContextCommand(args: {
  db: SupabaseClient
  conversationId: string
  command: Exclude<ContextCommand, null>
  active: ActiveContexts
  staleQuote?: StaleQuoteInfo | null
}): Promise<ContextCommandResult> {
  const { db, conversationId, command, active } = args

  const cleared: string[] = []
  if (active.voucher) cleared.push('un comprobante pendiente')
  if (active.expense) cleared.push('un gasto a medio cargar')
  if (active.attendance) cleared.push('una asistencia pendiente')
  if (active.order) cleared.push('un presupuesto pendiente')
  if (active.clarify) cleared.push('una pregunta pendiente')

  await Promise.all([
    clearVoucherContext(db, conversationId),
    clearExpenseContext(db, conversationId),
    clearAttendanceContext(db, conversationId),
    clearClarifyContext(db, conversationId),
    clearOrderContext(db, conversationId),
  ])

  if (command === 'reset_all') {
    return {
      handled: true,
      reply: cleared.length > 0
        ? `Listo, borré todo lo que estaba pendiente (${cleared.join(', ')}). Empezá de nuevo cuando quieras 😉`
        : 'Listo, borré todo. Empezá de nuevo cuando quieras 😉',
    }
  }

  // cancel_active
  if (cleared.length === 0) {
    const q = args.staleQuote
    if (q && (q.total || q.items)) {
      const what =
        q.total && q.total > 0 ? `la cotización de $${q.total.toLocaleString('es-AR')}` : 'tu cotización'
      return {
        handled: true,
        reply: `Esa ${what} venció. ¿Querés que la arme de nuevo? Mandame los productos y medidas.`,
      }
    }
    return { handled: true, reply: 'No tenías nada pendiente. ¿En qué te ayudo?' }
  }
  return {
    handled: true,
    reply: `Listo, descarté ${cleared.join(' y ')}. Si querés, mandámelo de nuevo.`,
  }
}
