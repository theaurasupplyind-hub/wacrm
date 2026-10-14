import { describe, it, expect } from 'vitest'
import { buildBotContextText } from './context'
import { QUOTE_TTL_MS, STALE_QUOTE_RECALL_MS } from '@/lib/pedidos/context'
import type { OrderContext } from '@/lib/pedidos/types'

function orderCtx(over: Partial<OrderContext> = {}): OrderContext {
  return {
    stage: 'confirming',
    items: [],
    clienteNombre: null,
    total: 676000,
    faltantes: [],
    notaSupuestos: [],
    updatedAt: Date.now(),
    ...over,
  } as OrderContext
}

describe('buildBotContextText: expiración de pedido (fix #3)', () => {
  it('cotización activa se presenta como pendiente', () => {
    const txt = buildBotContextText({
      orderCtx: orderCtx({ awaitingQuoteApproval: true, quoteText: 'x' }),
    })
    expect(txt).toContain('Cotización pendiente')
    expect(txt).not.toContain('VENCIDA')
  })

  it('cotización vencida recordable se marca VENCIDA (no aceptable)', () => {
    const txt = buildBotContextText({
      orderCtx: orderCtx({
        awaitingQuoteApproval: true,
        quoteText: 'x',
        updatedAt: Date.now() - QUOTE_TTL_MS - 3600_000,
      }),
    })
    expect(txt).toContain('VENCIDA')
    expect(txt).toContain('676.000')
    expect(txt).not.toContain('Cotización pendiente (solo preview')
  })

  it('contexto muy viejo no se menciona', () => {
    const txt = buildBotContextText({
      orderCtx: orderCtx({
        awaitingQuoteApproval: true,
        updatedAt: Date.now() - STALE_QUOTE_RECALL_MS - 1000,
      }),
    })
    expect(txt).not.toContain('Cotización')
    expect(txt).not.toContain('Pedido pendiente')
  })

  it('sin orderCtx no hay líneas de pedido', () => {
    expect(buildBotContextText({})).not.toContain('Cotización')
  })
})
