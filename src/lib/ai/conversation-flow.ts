export interface FlowResult {
  action: 'confirm' | 'handoff' | 'continue'
  reason?: string
  cartStatus?: string
}

export function determineFlow(
  cart: { status: string; items?: unknown[] } | undefined,
  intent: string,
  text: string,
): FlowResult {
  if (intent === 'order_request') {
    return { action: 'continue' }
  }

  if (intent === 'confirm_order') {
    if (!cart?.items?.length) {
      return { action: 'handoff', reason: 'confirm_order without active cart' }
    }
    return {
      action: 'confirm',
      cartStatus: 'confirmado',
      reason: 'user confirmed order',
    }
  }

  return { action: 'continue' }
}
