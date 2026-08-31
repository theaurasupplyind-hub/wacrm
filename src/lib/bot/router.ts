import type { BotIntent, UnifiedExtraction } from '@/lib/bot-llm/types'
import { shouldSuppressVoiceOrder } from '@/lib/bot-coordination'
import { looksLikeExpense } from '@/lib/expenses'
import { looksLikeAttendance } from '@/lib/attendance'
import { isCategoryCorrectionCommand } from '@/lib/expenses/command'

export type DispatchedTo = 'expense' | 'attendance' | 'voucher' | 'voice' | 'flow' | 'interactive' | 'none'
export type DispatchReason =
  | 'pending_multiturn'
  | 'category_correction'
  | 'intent'
  | 'multi_expense'
  | 'fallback_regex'
  | 'consumed'
  | 'none'

export interface RouterState {
  hasPendingExpense: boolean
  hasPendingAttendance: boolean
  hasPendingVoucher: boolean
  flowConsumed: boolean
  interactiveReplyId: string | null
  inboundText: string
  extraction: UnifiedExtraction | null
  mediaConsumedByVoucher: boolean
}

export interface RouterDecision {
  dispatchedTo: DispatchedTo
  dispatchReason: DispatchReason
}

function isAsistenciaIntent(intent: BotIntent | undefined): boolean {
  return intent === 'asistencia_llegada' || intent === 'asistencia_salida' || intent === 'asistencia_estado'
}

export function decideDispatch(state: RouterState): RouterDecision {
  const { hasPendingExpense, hasPendingAttendance, hasPendingVoucher, flowConsumed, interactiveReplyId, inboundText, extraction, mediaConsumedByVoucher } = state
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
  if (!flowConsumed && !interactiveReplyId && hasPendingExpense && intent !== 'gasto') {
    return { dispatchedTo: 'expense', dispatchReason: 'pending_multiturn' }
  }
  if (!flowConsumed && !interactiveReplyId && hasPendingAttendance && !isAsistenciaIntent(intent)) {
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
  if ((intent === 'pedido' || intent === 'factura') && confianza !== 'baja' && suppressVoice) {
    return { dispatchedTo: 'voice', dispatchReason: 'intent' }
  }

  // Fallback regex gates — mirrors webhook fallback
  const isExpenseText = !flowConsumed && !interactiveReplyId && (hasPendingExpense || (inboundText.trim() && looksLikeExpense(inboundText)))
  if (isExpenseText) {
    return { dispatchedTo: 'expense', dispatchReason: 'fallback_regex' }
  }
  if (!flowConsumed && !interactiveReplyId && inboundText.trim() && (hasPendingAttendance || looksLikeAttendance(inboundText))) {
    return { dispatchedTo: 'attendance', dispatchReason: 'fallback_regex' }
  }
  if (!flowConsumed && !interactiveReplyId && inboundText.trim() && suppressVoice) {
    return { dispatchedTo: 'voice', dispatchReason: 'fallback_regex' }
  }

  return { dispatchedTo: 'none', dispatchReason: 'none' }
}
