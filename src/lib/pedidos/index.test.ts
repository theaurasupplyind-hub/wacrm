import { describe, it, expect, vi, beforeEach } from 'vitest'

const facbal = vi.hoisted(() => ({
  createInvoice: vi.fn(),
  nextInvoiceNumber: vi.fn(),
  searchClients: vi.fn(),
  createClient: vi.fn(),
  findClientMatches: vi.fn(),
  getPreciosReferencia: vi.fn(),
  getPricingRules: vi.fn(),
}))

vi.mock('@/lib/facbal/client', () => facbal)

const sent = vi.hoisted(() => ({ texts: [] as string[], buttons: [] as { bodyText: string; buttons: { id: string }[] }[] }))

vi.mock('@/lib/flows/meta-send', () => ({
  engineSendText: vi.fn(async (a: { text: string }) => {
    sent.texts.push(a.text)
    return { whatsapp_message_id: 'x' }
  }),
  engineSendInteractiveButtons: vi.fn(async (a: { bodyText: string; buttons: { id: string }[] }) => {
    sent.buttons.push(a)
    return { whatsapp_message_id: 'x' }
  }),
}))

vi.mock('@/lib/pedidos/send-receipt', () => ({
  sendPedidoReceipt: vi.fn(async () => true),
}))

vi.mock('@/lib/bot-trace/record', () => ({
  recordBotTrace: vi.fn(async () => {}),
}))

import { processPedidoMessage } from './index'
import { preciosReferencia, pricingRules } from '../precios/__fixtures__/catalogo'

function makeDb() {
  const state: { order: unknown } = { order: null }
  const db = {
    from(table: string) {
      if (table === 'order_glossary') {
        return { select: () => ({ eq: async () => ({ data: [] }) }) }
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { order_context: state.order } }) }) }),
        update: (vals: Record<string, unknown>) => ({
          eq: async () => {
            state.order = vals.order_context
            return { error: null }
          },
        }),
      }
    },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return db as any
}

type Extra = Record<string, unknown>

function args(db: unknown, text: string, extra: Extra = {}) {
  return {
    db,
    text,
    accountId: 'acc',
    userId: 'u',
    conversationId: 'conv',
    contactId: 'ct',
    senderPhone: '5491100000000',
    senderName: 'Juan',
    accessToken: 'tok',
    refs: preciosReferencia,
    rules: pricingRules,
    parseFn: async () => ({
      cliente: 'Juan',
      items: [{ cantidad: 2, texto: 'bastidor sin tela 60x40' }],
    }),
    findClientsFn: async () => [{ id: 7, nombre: 'Juan', telefono: null, score: 0.9 }],
    ...extra,
  } as Parameters<typeof processPedidoMessage>[0]
}

describe('processPedidoMessage — datos de entrega', () => {
  beforeEach(() => {
    sent.texts = []
    sent.buttons = []
    facbal.nextInvoiceNumber.mockResolvedValue('F-1001')
    facbal.createInvoice.mockImplementation(async (p: Record<string, unknown>) => ({
      id: 55,
      numero_factura: p.numero_factura,
      numero_presupuesto: p.numero_presupuesto,
      fecha: p.fecha,
      cliente_nombre: p.cliente_nombre,
      total: p.total,
      tipo: p.tipo,
    }))
    facbal.searchClients.mockResolvedValue(null)
    facbal.createClient.mockResolvedValue({ id: 10, nombre: 'X' })
  })

  it('recolecta cliente, entrega, fecha y descuento, y crea con esos datos', async () => {
    const db = makeDb()

    // 1. Pedido nuevo → pregunta el cliente (con candidato).
    await processPedidoMessage(args(db, '2 bastidores 60x40 sin tela'))
    expect(sent.buttons.at(-1)?.bodyText).toContain('Juan')

    // 2. Confirmar cliente → pregunta entrega (botones).
    await processPedidoMessage(args(db, '', { interactiveReplyId: 'pedido_cli_ok' }))
    expect(sent.buttons.at(-1)?.buttons.map(b => b.id)).toContain('pedido_entrega_envio')

    // 3. Entrega = Envío → pregunta fecha.
    await processPedidoMessage(args(db, '', { interactiveReplyId: 'pedido_entrega_envio' }))
    expect(sent.texts.at(-1)).toMatch(/Fecha de entrega/)

    // 4. Fecha → pregunta descuento.
    await processPedidoMessage(args(db, 'el viernes'))
    expect(sent.texts.at(-1)).toMatch(/Descuento/)

    // 5. Descuento 10% → resumen final.
    await processPedidoMessage(args(db, '10%'))
    expect(sent.texts.at(-1)).toMatch(/¿Confirmás\?/)

    // 6. Confirmar → crea el presupuesto con todos los datos.
    const r = await processPedidoMessage(args(db, 'sí'))
    expect(r.createdInvoice).toBeTruthy()

    const payload = facbal.createInvoice.mock.calls[0][0] as {
      tipo_entrega: string
      fecha_entrega: string
      cliente_id: number | null
      total: number
      items: { descripcion: string; total: number }[]
    }
    expect(payload.cliente_id).toBe(7)
    expect(payload.tipo_entrega).toBe('Envio')
    expect(payload.fecha_entrega).toContain('"desde"')
    expect(payload.total).toBe(32400)
    expect(payload.items.find(i => i.descripcion === 'DESCUENTO')?.total).toBe(-3600)
  })

  it('sin candidatos no pregunta y sigue con la entrega', async () => {
    const db = makeDb()
    await processPedidoMessage(
      args(db, '2 bastidores 60x40 sin tela', { findClientsFn: async () => [] }),
    )
    // El primer mensaje es la pregunta de entrega (no hay candidato que confirmar).
    expect(sent.buttons.at(-1)?.buttons.map(b => b.id)).toContain('pedido_entrega_retira')

    // Elegir "retira" y luego saltear fecha y descuento.
    await processPedidoMessage(args(db, '', { interactiveReplyId: 'pedido_entrega_retira', findClientsFn: async () => [] }))
    await processPedidoMessage(args(db, 'no', { findClientsFn: async () => [] }))
    await processPedidoMessage(args(db, 'no', { findClientsFn: async () => [] }))
    const r = await processPedidoMessage(args(db, 'sí', { findClientsFn: async () => [] }))
    expect(r.createdInvoice).toBeTruthy()
    const payload = facbal.createInvoice.mock.calls[0][0] as { tipo_entrega: string; items: { descripcion: string }[] }
    expect(payload.tipo_entrega).toBe('Retira')
    expect(payload.items.some(i => i.descripcion === 'DESCUENTO')).toBe(false)
  })
})
