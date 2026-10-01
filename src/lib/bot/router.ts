import type { BotIntent, UnifiedExtraction } from '@/lib/bot-llm/types'
import type { JevPendingSignal } from '@/lib/bot-llm/classify-jev'
import { looksLikeExpense } from '@/lib/expenses'
import { looksLikeAttendance } from '@/lib/attendance'
import { isCategoryCorrectionCommand } from '@/lib/expenses/command'

export type DispatchedTo = 'expense' | 'attendance' | 'voucher' | 'flow' | 'interactive' | 'assistant' | 'clarify' | 'none'
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
 *
 * 24 h: WhatsApp es asíncrono; una aclaración ("¿es proveedor o empleado?")
 * puede responderse horas después. Con 15 min el borrador se perdía y una
 * respuesta corta posterior reiniciaba el flujo (bug "80000 a julian").
 */
export const PENDING_CONTEXT_TTL_MS = 24 * 60 * 60 * 1000

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
  /**
   * El usuario respondió a una aclaración pendiente (botones/tap o texto) y
   * eligió este intent. Es la autoridad de ruteo de esa respuesta: gana al
   * fallback regex, que de lo contrario lee el título del botón como orden
   * (ej. "Me pagó (cobro)" matchea looksLikeExpense).
   */
  clarifyAnsweredIntent?: BotIntent | null
}

export interface RouterDecision {
  dispatchedTo: DispatchedTo
  dispatchReason: DispatchReason
}

function isAsistenciaIntent(intent: BotIntent | undefined): boolean {
  return intent === 'asistencia_llegada' || intent === 'asistencia_salida' || intent === 'asistencia_estado'
}

/** Mapea el intent elegido al responder una aclaración a su dominio de dispatch. */
function resolveClarifyIntent(intent: BotIntent): RouterDecision {
  if (intent === 'gasto' || intent === 'multi_expense') return { dispatchedTo: 'expense', dispatchReason: 'clarify_resolve' }
  if (intent === 'voucher') return { dispatchedTo: 'voucher', dispatchReason: 'clarify_resolve' }
  if (isAsistenciaIntent(intent)) return { dispatchedTo: 'attendance', dispatchReason: 'clarify_resolve' }
  return { dispatchedTo: 'assistant', dispatchReason: 'clarify_resolve' }
}

export function decideDispatch(state: RouterState): RouterDecision {
  const { hasPendingExpense, hasPendingAttendance, flowConsumed, interactiveReplyId, inboundText, extraction, jevPending, clarifyAnsweredIntent } = state
  const intent = extraction?.intent
  const confianza = extraction?.confianza

  // Flow / interactive already consumed
  if (flowConsumed) return { dispatchedTo: 'flow', dispatchReason: 'consumed' }
  // Respuesta a una aclaración: el intent elegido manda. Va antes del check
  // interactivo y del fallback regex para no re-clasificar el título del botón.
  if (clarifyAnsweredIntent) return resolveClarifyIntent(clarifyAnsweredIntent)
  if (interactiveReplyId) return { dispatchedTo: 'interactive', dispatchReason: 'consumed' }

  // Primary dispatch — mirrors webhook route.ts
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
  // Conversacional / deuda: "cuanto debe", saludos, capacidades → asistente.
  const conversationalDebtRe = /cu[aá]nto debe|cu[aá]nto le queda|saldo pendiente|deuda de|qu[eé] pod[eé]s hacer|qui[eé]n sos|qui[eé]n eres|qu[eé] hac[eé]s|capacidades|tiene alguna factura|facturas de/i
  if (inboundText && conversationalDebtRe.test(inboundText)) {
    return { dispatchedTo: 'assistant', dispatchReason: 'intent' }
  }
  if (intent === 'factura') {
    return { dispatchedTo: 'assistant', dispatchReason: 'intent' }
  }
  if (intent === 'otro') {
    return { dispatchedTo: 'assistant', dispatchReason: 'intent' }
  }

  // Fallback regex gates — mirrors webhook fallback
  const isExpenseText = !flowConsumed && !interactiveReplyId && ((hasPendingExpense && !jevSupersede) || (inboundText.trim() && looksLikeExpense(inboundText)))
  if (isExpenseText) {
    return { dispatchedTo: 'expense', dispatchReason: 'fallback_regex' }
  }
  if (!flowConsumed && !interactiveReplyId && inboundText.trim() && ((hasPendingAttendance && !jevSupersede) || looksLikeAttendance(inboundText))) {
    return { dispatchedTo: 'attendance', dispatchReason: 'fallback_regex' }
  }
  // Sin dominio de pedidos, cualquier texto no clasificado va al asistente
  // (que responde o pide aclaración: nunca queda mudo).
  if (!flowConsumed && !interactiveReplyId && inboundText.trim()) {
    return { dispatchedTo: 'assistant', dispatchReason: 'fallback_regex' }
  }

  return { dispatchedTo: 'none', dispatchReason: 'none' }
}
