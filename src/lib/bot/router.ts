import type { BotIntent, UnifiedExtraction } from '@/lib/bot-llm/types'
import type { JevPendingSignal } from '@/lib/bot-llm/classify-jev'
import { shouldSuppressVoiceOrder } from '@/lib/bot-coordination'
import { looksLikeExpense } from '@/lib/expenses'
import { looksLikeAttendance } from '@/lib/attendance'
import { isCategoryCorrectionCommand } from '@/lib/expenses/command'

export type DispatchedTo = 'expense' | 'attendance' | 'voucher' | 'voice' | 'flow' | 'interactive' | 'assistant' | 'clarify' | 'none'
export type DispatchReason =
  | 'pending_multiturn'
  | 'pending_expired'
  | 'category_correction'
  | 'clarify_resolve'
  | 'clarify_superseded'
  | 'clarify_ask'
  | 'clarify_reask'
  | 'clarify_expired'
  | 'clarify_cancelled'
  | 'intent'
  | 'multi_expense'
  | 'fallback_regex'
  | 'consumed'
  | 'none'

/**
 * Tiempo máximo que un contexto multi-turn (gasto/asistencia) bloquea
 * mensajes de otro intent. Pasado este TTL el pendiente se considera
 * abandonado y un intent fuerte lo reemplaza (ver route.ts).
 */
export const PENDING_CONTEXT_TTL_MS = 15 * 60 * 1000

/**
 * Umbrales de la señal Jev para el ruteo de pendientes. Solo se aplican si el
 * llamador pasa `jevPending` (JEV_ENABLED=true y JEV_SHADOW=false).
 */
export const JEV_ANSWERS_PENDING_MIN = 0.7
export const JEV_SUPERSEDES_MIN = 0.7

export interface RouterState {
  hasPendingExpense: boolean
  hasPendingAttendance: boolean
  hasPendingVoucher: boolean
  hasPendingVoice?: boolean
  flowConsumed: boolean
  interactiveReplyId: string | null
  inboundText: string
  extraction: UnifiedExtraction | null
  mediaConsumedByVoucher: boolean
  /**
   * Señal auxiliar de Jev (System One) sobre el mensaje pendiente. Opcional:
   * si falta, el router se comporta exactamente como antes.
   */
  jevPending?: JevPendingSignal | null
}

export interface RouterDecision {
  dispatchedTo: DispatchedTo
  dispatchReason: DispatchReason
}

function isAsistenciaIntent(intent: BotIntent | undefined): boolean {
  return intent === 'asistencia_llegada' || intent === 'asistencia_salida' || intent === 'asistencia_estado'
}

export function decideDispatch(state: RouterState): RouterDecision {
  const { hasPendingExpense, hasPendingAttendance, hasPendingVoucher, hasPendingVoice, flowConsumed, interactiveReplyId, inboundText, extraction, mediaConsumedByVoucher, jevPending } = state
  const intent = extraction?.intent
  const confianza = extraction?.confianza

  // Flow / interactive already consumed
  if (flowConsumed) return { dispatchedTo: 'flow', dispatchReason: 'consumed' }
  if (interactiveReplyId) return { dispatchedTo: 'interactive', dispatchReason: 'consumed' }

  const suppressVoice = !shouldSuppressVoiceOrder({ hasPendingExpense, hasPendingVoucher, hasPendingAttendance, flowConsumed, mediaConsumedByVoucher })

  // Primary dispatch — mirrors webhook route.ts:1538-1600
  if (!flowConsumed && !interactiveReplyId && isCategoryCorrectionCommand(inboundText)) {
    return { dispatchedTo: 'expense', dispatchReason: 'category_correction' }
  }

  // Jev (System One): ruteo de pendientes con confianza calibrada. Resuelve
  // respuestas cortas ("5000", "la 2", "8:30") que las reglas duras perdían.
  const jevSupersede = !!jevPending && jevPending.supersedes >= JEV_SUPERSEDES_MIN
  if (
    jevPending &&
    !jevSupersede &&
    jevPending.domain !== 'none' &&
    jevPending.answersPending >= JEV_ANSWERS_PENDING_MIN
  ) {
    if (jevPending.domain === 'expense') return { dispatchedTo: 'expense', dispatchReason: 'pending_multiturn' }
    if (jevPending.domain === 'attendance') return { dispatchedTo: 'attendance', dispatchReason: 'pending_multiturn' }
    if (jevPending.domain === 'voucher') return { dispatchedTo: 'voucher', dispatchReason: 'pending_multiturn' }
    if (jevPending.domain === 'voice') return { dispatchedTo: 'voice', dispatchReason: 'pending_multiturn' }
  }
  // Escape de intent fuerte: un mensaje completo nuevo (confianza alta/media)
  // no debe quedar atrapado por un pendiente abandonado de otro dominio.
  // Sin esto, "Eze llegó 9:15" con un gasto a medio completar iba a
  // expense/pending_multiturn y nunca se registraba la asistencia.
  const strongIntent = confianza === 'alta' || confianza === 'media'
  if (!flowConsumed && !interactiveReplyId && strongIntent) {
    if (isAsistenciaIntent(intent)) {
      return { dispatchedTo: 'attendance', dispatchReason: 'intent' }
    }
    if (intent === 'gasto' || intent === 'multi_expense') {
      return { dispatchedTo: 'expense', dispatchReason: 'intent' }
    }
    if (intent === 'voucher') {
      return { dispatchedTo: 'voucher', dispatchReason: 'intent' }
    }
  }
  if (!flowConsumed && !interactiveReplyId && hasPendingExpense && intent !== 'gasto' && !jevSupersede) {
    return { dispatchedTo: 'expense', dispatchReason: 'pending_multiturn' }
  }
  if (!flowConsumed && !interactiveReplyId && hasPendingAttendance && !isAsistenciaIntent(intent) && !jevSupersede) {
    return { dispatchedTo: 'attendance', dispatchReason: 'pending_multiturn' }
  }
  if (intent === 'multi_expense') {
    return { dispatchedTo: 'expense', dispatchReason: 'multi_expense' }
  }
  if (intent === 'gasto') {
    return { dispatchedTo: 'expense', dispatchReason: 'intent' }
  }
  if (isAsistenciaIntent(intent)) {
    return { dispatchedTo: 'attendance', dispatchReason: 'intent' }
  }
  if (intent === 'voucher') {
    return { dispatchedTo: 'voucher', dispatchReason: 'intent' }
  }
  // Guard de confirmación: si hay presupuesto/variante pendiente, la confirmación no debe ir al asistente
  // Conversacional / deuda: "cuanto debe" siempre va al asistente, nunca a voice (evita "No se reconoció ningún producto")
  const conversationalDebtRe = /cu[aá]nto debe|cu[aá]nto le queda|saldo pendiente|deuda de|qu[eé] pod[eé]s hacer|qui[eé]n sos|qui[eé]n eres|qu[eé] hac[eé]s|capacidades/i
  if (inboundText && conversationalDebtRe.test(inboundText) && !hasPendingVoice) {
    return { dispatchedTo: 'assistant', dispatchReason: 'intent' }
  }
  if (hasPendingVoice && !jevSupersede) {
    return { dispatchedTo: 'voice', dispatchReason: 'pending_multiturn' }
  }
  if (intent === 'factura') {
    return { dispatchedTo: 'assistant', dispatchReason: 'intent' }
  }
  if (intent === 'otro') {
    return { dispatchedTo: 'assistant', dispatchReason: 'intent' }
  }
  if (intent === 'pedido' && confianza !== 'baja' && suppressVoice) {
    return { dispatchedTo: 'voice', dispatchReason: 'intent' }
  }

  // Fallback regex gates — mirrors webhook fallback
  const isExpenseText = !flowConsumed && !interactiveReplyId && ((hasPendingExpense && !jevSupersede) || (inboundText.trim() && looksLikeExpense(inboundText)))
  if (isExpenseText) {
    return { dispatchedTo: 'expense', dispatchReason: 'fallback_regex' }
  }
  if (!flowConsumed && !interactiveReplyId && inboundText.trim() && ((hasPendingAttendance && !jevSupersede) || looksLikeAttendance(inboundText))) {
    return { dispatchedTo: 'attendance', dispatchReason: 'fallback_regex' }
  }
  if (!flowConsumed && !interactiveReplyId && inboundText.trim() && suppressVoice) {
    // No atrapar conversacional deuda en fallback voice
    if (/cu[aá]nto debe|saldo|deuda|qu[eé] pod[eé]s|qui[eé]n sos/i.test(inboundText)) {
      return { dispatchedTo: 'assistant', dispatchReason: 'fallback_regex' }
    }
    return { dispatchedTo: 'voice', dispatchReason: 'fallback_regex' }
  }

  return { dispatchedTo: 'none', dispatchReason: 'none' }
}
