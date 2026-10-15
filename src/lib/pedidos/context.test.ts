import { describe, it, expect } from 'vitest'
import { isOrderContextActive, isResumableQuote, getStaleQuote, PENDING_ORDER_TTL_MS, QUOTE_TTL_MS, STALE_QUOTE_RECALL_MS } from './context'
import type { OrderContext } from './types'

function ctx(over: Partial<OrderContext> = {}): OrderContext {
  return {
    stage: 'confirming',
    items: [],
    clienteNombre: null,
    total: 0,
    faltantes: [],
    notaSupuestos: [],
    updatedAt: Date.now(),
    ...over,
  }
}

describe('TTL diferenciado del pedido (notas-fallos-reales.md #1)', () => {
  it('slots: 30 min (29 sí, 31 no)', () => {
    const now = Date.now()
    expect(isOrderContextActive(ctx({ updatedAt: now - PENDING_ORDER_TTL_MS + 60_000 }), now)).toBe(true)
    expect(isOrderContextActive(ctx({ updatedAt: now - PENDING_ORDER_TTL_MS - 60_000 }), now)).toBe(false)
  })

  it('cotización presentada: 24h (23 sí, 25 no)', () => {
    const now = Date.now()
    const quote = { awaitingQuoteApproval: true, quoteText: 'x' }
    expect(
      isOrderContextActive(ctx({ ...quote, updatedAt: now - QUOTE_TTL_MS + 3600_000 }), now),
    ).toBe(true)
    expect(
      isOrderContextActive(ctx({ ...quote, updatedAt: now - QUOTE_TTL_MS - 3600_000 }), now),
    ).toBe(false)
  })

  it('casos borde: sin stage, sin updatedAt', () => {
    expect(isOrderContextActive(null)).toBe(false)
    expect(isOrderContextActive(ctx({ stage: undefined as never }))).toBe(false)
    expect(isOrderContextActive(ctx({ updatedAt: undefined }))).toBe(true)
  })
})

describe('getStaleQuote (fix #2: cancela quote-aware)', () => {
  it('cotización vencida reciente se recuerda', () => {
    const now = Date.now()
    const stale = getStaleQuote(
      ctx({ awaitingQuoteApproval: true, quoteText: 'x', total: 676000, updatedAt: now - QUOTE_TTL_MS - 3600_000 }),
      now,
    )
    expect(stale?.total).toBe(676000)
  })

  it('activa, ausente o muy vieja → null', () => {
    const now = Date.now()
    expect(getStaleQuote(ctx({ awaitingQuoteApproval: true, updatedAt: now }), now)).toBeNull()
    expect(getStaleQuote(null, now)).toBeNull()
    expect(
      getStaleQuote(
        ctx({ awaitingQuoteApproval: true, updatedAt:         now - STALE_QUOTE_RECALL_MS - 1000 }),
        now,
      ),
    ).toBeNull()
  })
})

describe('soft-cancel: cotización descartada reanudable (incidente 15/10)', () => {
  it('una cotización descartada NO es un pendiente activo', () => {
    const now = Date.now()
    expect(isOrderContextActive(ctx({ quoteCancelled: true, updatedAt: now }), now)).toBe(false)
  })

  it('es reanudable dentro del TTL de recall (7 días) y no después', () => {
    const now = Date.now()
    expect(isResumableQuote(ctx({ quoteCancelled: true, updatedAt: now }), now)).toBe(true)
    expect(
      isResumableQuote(ctx({ quoteCancelled: true, updatedAt: now - STALE_QUOTE_RECALL_MS - 1000 }), now),
    ).toBe(false)
  })

  it('sin quoteCancelled no es reanudable', () => {
    expect(isResumableQuote(ctx({ updatedAt: Date.now() }))).toBe(false)
  })

  it('una cotización descartada no se ofrece como vencida al comando cancela', () => {
    const now = Date.now()
    expect(
      getStaleQuote(ctx({ quoteCancelled: true, updatedAt: now - QUOTE_TTL_MS - 1000 }), now),
    ).toBeNull()
  })
})
