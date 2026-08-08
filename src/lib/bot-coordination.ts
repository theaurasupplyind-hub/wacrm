export interface VoiceOrderSuppressState {
  hasPendingExpense: boolean
  hasPendingVoucher: boolean
  hasPendingAttendance: boolean
  flowConsumed: boolean
  mediaConsumedByVoucher?: boolean
}

export function shouldSuppressVoiceOrder(state: VoiceOrderSuppressState): boolean {
  if (state.flowConsumed) return true
  if (state.mediaConsumedByVoucher) return true
  if (state.hasPendingExpense) return true
  if (state.hasPendingVoucher) return true
  if (state.hasPendingAttendance) return true
  return false
}
