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

export type ContextCommand = 'cancel_active' | 'reset_all' | null

const RESET_RE = /^(reiniciar|reinicia|reinicio|empezar de nuevo|empezar de cero|arrancar de nuevo|arrancar de cero|borrar todo|borra todo|resetear|reset|olvida todo|olvid[aá]te de todo|salir|chau bot|jesusdanielllavesecreta)[.!]*$/i

const CANCEL_RE = /^(cancelar|cancela|cancelo|olvidalo|olv[ií]dalo|mejor no|despu[eé]s|todav[ií]a no|nada|ninguno|ninguna|saltar|saltear)[.!]*$/i

export function classifyContextCommand(text: string): ContextCommand {
  const t = (text || '').trim()
  if (!t) return null
  if (RESET_RE.test(t)) return 'reset_all'
  if (CANCEL_RE.test(t)) return 'cancel_active'
  return null
}

export interface ActiveContexts {
  expense?: boolean
  attendance?: boolean
  voucher?: boolean
  clarify?: boolean
}

export interface ContextCommandResult {
  handled: boolean
  reply?: string
}

/**
 * Aplica el comando. `cancel_active` descarta solo lo pendiente; si no hay
 * nada, igual limpia por las dudas y responde corto. `reset_all` limpia todo.
 */
export async function handleContextCommand(args: {
  db: SupabaseClient
  conversationId: string
  command: Exclude<ContextCommand, null>
  active: ActiveContexts
}): Promise<ContextCommandResult> {
  const { db, conversationId, command, active } = args

  const cleared: string[] = []
  if (active.voucher) cleared.push('un comprobante pendiente')
  if (active.expense) cleared.push('un gasto a medio cargar')
  if (active.attendance) cleared.push('una asistencia pendiente')
  if (active.clarify) cleared.push('una pregunta pendiente')

  await Promise.all([
    clearVoucherContext(db, conversationId),
    clearExpenseContext(db, conversationId),
    clearAttendanceContext(db, conversationId),
    clearClarifyContext(db, conversationId),
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
    return { handled: true, reply: 'No tenías nada pendiente. ¿En qué te ayudo?' }
  }
  return {
    handled: true,
    reply: `Listo, descarté ${cleared.join(' y ')}. Si querés, mandámelo de nuevo.`,
  }
}
