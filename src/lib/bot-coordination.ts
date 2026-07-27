export interface VoiceOrderSuppressState {
  hasPendingExpense: boolean
  hasPendingVoucher: boolean
  flowConsumed: boolean
}

export function shouldSuppressVoiceOrder(state: VoiceOrderSuppressState): boolean {
  if (state.flowConsumed) return true
  if (state.hasPendingExpense) return true
  if (state.hasPendingVoucher) return true
  return false
}
