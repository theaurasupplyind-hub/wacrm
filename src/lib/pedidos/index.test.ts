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

function makeDb(glossaryRows: unknown[] = []) {
  const state: { order: unknown } = { order: null }
  const db = {
    from(table: string) {
      if (table === 'order_glossary') {
        return { select: () => ({ eq: async () => ({ data: glossaryRows }) }) }
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
  return Object.assign(db as any, { getOrderContext: () => state.order })
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

describe('processPedidoMessage — creación de presupuesto', () => {
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

  it('pide cliente y confirmación; usa defaults de entrega, fecha y descuento', async () => {
    const db = makeDb()

    // 1. Creación explícita → confirma el cliente encontrado.
    await processPedidoMessage(args(db, 'Armame un presupuesto: 2 bastidores 60x40 sin tela'))
    expect(sent.buttons.at(-1)?.bodyText).toContain('Juan')

    // 2. Confirmar cliente → presenta el resumen final; no obliga a rellenar
    // entrega/fecha/descuento que el ERP ya permite dejar en sus defaults.
    await processPedidoMessage(args(db, '', { interactiveReplyId: 'pedido_cli_ok' }))
    expect(sent.texts.at(-1)).toMatch(/¿Confirmás\?/)
    expect(sent.texts.at(-1)).not.toMatch(/¿Cómo lo entregamos|Fecha de entrega|¿Descuento\?/)

    // 3. Confirmar → crea el presupuesto con los defaults del ERP.
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
    expect(payload.tipo_entrega).toBe('Retira')
    expect(payload.fecha_entrega).toBe('')
    expect(payload.total).toBe(36000)
    expect(payload.items.some(i => i.descripcion === 'DESCUENTO')).toBe(false)
  })

  it('sin candidatos identifica cliente nuevo en el resumen antes de guardar', async () => {
    const db = makeDb()
    await processPedidoMessage(
      args(db, 'Armame un presupuesto: 2 bastidores 60x40 sin tela', { findClientsFn: async () => [] }),
    )
    expect(sent.texts.at(-1)).toContain('Cliente nuevo: Juan')
    expect(sent.texts.at(-1)).toContain('¿Confirmás?')

    const r = await processPedidoMessage(args(db, 'sí', { findClientsFn: async () => [] }))
    expect(r.createdInvoice).toBeTruthy()
    const payload = facbal.createInvoice.mock.calls[0][0] as { tipo_entrega: string; items: { descripcion: string }[] }
    expect(payload.tipo_entrega).toBe('Retira')
    expect(payload.items.some(i => i.descripcion === 'DESCUENTO')).toBe(false)
  })

  it('una consulta cotiza y ofrece crear; no busca clientes ni guarda presupuesto', async () => {
    const db = makeDb()
    const findClientsFn = vi.fn(async () => [])
    const parseFn = async () => ({
      cliente: null,
      items: [{ cantidad: 1, texto: 'bastidor 20x20 lienzo profesional' }],
    })

    const result = await processPedidoMessage(args(db, 'Quería saber si tienen bastidores de 20x20', {
      parseFn,
      findClientsFn,
    }))

    expect(result.handled).toBe(true)
    expect(sent.texts.at(-1)).toContain('Cotización estimada:')
    expect(sent.texts.at(-1)).toContain('¿Querés que la convierta en presupuesto?')
    expect(sent.texts.at(-1)).not.toContain('Voy a armar este presupuesto')
    expect(findClientsFn).not.toHaveBeenCalled()
    expect(facbal.createInvoice).not.toHaveBeenCalled()
    expect((db as ReturnType<typeof makeDb>).getOrderContext()).toMatchObject({
      awaitingQuoteApproval: true,
    })
  })

  it('"no lo creas, era una prueba" cierra la cotización sin buscar clientes ni escribir', async () => {
    const db = makeDb()
    const findClientsFn = vi.fn(async () => [])
    const parseFn = async () => ({
      cliente: null,
      items: [{ cantidad: 1, texto: 'bastidor 20x20 lienzo profesional' }],
    })

    await processPedidoMessage(args(db, 'Quería saber si tienen bastidores de 20x20', {
      parseFn,
      findClientsFn,
    }))
    const result = await processPedidoMessage(args(db, 'no lo creas, era una prueba', {
      parseFn,
      findClientsFn,
    }))

    expect(result.text).toContain('no guardé ni creé ningún presupuesto')
    expect((db as ReturnType<typeof makeDb>).getOrderContext()).toEqual({})
    expect(findClientsFn).not.toHaveBeenCalled()
    expect(facbal.createClient).not.toHaveBeenCalled()
    expect(facbal.createInvoice).not.toHaveBeenCalled()
  })

  it('una corrección que empieza con "no" actualiza la cotización, no la cancela', async () => {
    const db = makeDb()
    const parseFn = async () => ({
      cliente: null,
      items: [{ cantidad: 1, texto: 'bastidor 20x20 lienzo profesional' }],
    })

    await processPedidoMessage(args(db, 'bastidor 20x20', { parseFn }))
    await processPedidoMessage(args(db, 'No, mejor cambialo a 20x30', { parseFn }))

    expect(sent.texts.at(-1)).toContain('Cotización estimada:')
    expect((db as ReturnType<typeof makeDb>).getOrderContext()).toMatchObject({
      awaitingQuoteApproval: true,
    })
    expect(facbal.createInvoice).not.toHaveBeenCalled()
  })

  it('si el dueño pide crear un presupuesto sin ítems, guarda el contexto del paso y espera productos', async () => {
    const db = makeDb()
    const parseFn = async (text: string) => ({
      cliente: null,
      items: text.includes('60x40') ? [{ cantidad: 2, texto: 'bastidor sin tela 60x40' }] : [],
    })

    await processPedidoMessage(args(db, 'Armame un presupuesto', { parseFn }))
    expect(sent.texts.at(-1)).toContain('¿qué productos y medidas incluyo en el presupuesto?')
    expect((db as ReturnType<typeof makeDb>).getOrderContext()).toMatchObject({
      awaitingOrderItems: true,
    })

    await processPedidoMessage(args(db, '2 bastidores 60x40 sin tela', { parseFn, findClientsFn: async () => [] }))
    expect(sent.texts.at(-1)).toContain('¿A nombre de quién armo el presupuesto?')
    expect((db as ReturnType<typeof makeDb>).getOrderContext()).not.toMatchObject({
      awaitingOrderItems: true,
    })
  })

  it('al aceptar una cotización pide solo cliente y confirmación; usa defaults del ERP', async () => {
    const db = makeDb()
    const parseFn = async () => ({
      cliente: null,
      items: [{ cantidad: 1, texto: 'bastidor 20x20 lienzo profesional' }],
    })
    const findClientsFn = vi.fn(async () => [])

    await processPedidoMessage(args(db, 'Quería saber si tienen bastidores de 20x20', {
      parseFn,
      findClientsFn,
    }))
    await processPedidoMessage(args(db, 'sí', { parseFn, findClientsFn }))
    expect(sent.texts.at(-1)).toContain('¿A nombre de quién armo el presupuesto?')

    await processPedidoMessage(args(db, 'Fede', { parseFn, findClientsFn }))
    expect(sent.texts.at(-1)).toContain('¿Confirmás?')
    expect(sent.texts.join('\n')).not.toContain('¿Cómo lo entregamos?')
    expect(sent.texts.join('\n')).not.toContain('¿Fecha de entrega?')
    expect(sent.texts.join('\n')).not.toContain('¿Descuento?')
    expect(facbal.createInvoice).not.toHaveBeenCalled()

    const result = await processPedidoMessage(args(db, 'sí', { parseFn, findClientsFn }))
    expect(result.createdInvoice).toBeTruthy()
    expect(facbal.createClient).toHaveBeenCalledWith({ nombre: 'Fede' })
    expect(facbal.createInvoice).toHaveBeenCalledTimes(1)
  })

  it('no usa el teléfono del remitente como nombre ni como candidato de cliente', async () => {
    const db = makeDb()
    const findClientsFn = vi.fn(async () => [
      { id: 1, nombre: 'Cliente 5491100000000', telefono: '5491100000000', score: 1 },
      { id: 2, nombre: 'Fede', telefono: '5491100000000', score: 0.9 },
    ])
    const parseFn = async () => ({
      cliente: null,
      items: [{ cantidad: 1, texto: 'bastidor sin tela 60x40' }],
    })

    await processPedidoMessage(args(db, 'Armame un presupuesto de 60x40', {
      parseFn,
      findClientsFn,
    }))
    await processPedidoMessage(args(db, '5491100000000', { parseFn, findClientsFn }))

    expect(sent.texts.at(-1)).toContain('no lo voy a guardar como cliente')
    expect(findClientsFn).not.toHaveBeenCalled()
    expect((db as ReturnType<typeof makeDb>).getOrderContext()).toMatchObject({
      clienteNombre: null,
      awaitingCliente: true,
    })
    expect(facbal.createClient).not.toHaveBeenCalled()
    expect(facbal.createInvoice).not.toHaveBeenCalled()
  })

  it('busca por nombre, no por teléfono, y oculta el teléfono interno en opciones', async () => {
    const db = makeDb()
    const findClientsFn = vi.fn(async () => [
      { id: 1, nombre: 'Cliente 5491100000000', telefono: '5491100000000', score: 1 },
      { id: 2, nombre: 'Fede', telefono: '5491100000000', score: 0.9 },
    ])
    const parseFn = async () => ({
      cliente: 'Fede',
      items: [{ cantidad: 1, texto: 'bastidor sin tela 60x40' }],
    })

    await processPedidoMessage(args(db, 'Armame un presupuesto para Fede 60x40', {
      parseFn,
      findClientsFn,
    }))

    expect(findClientsFn).toHaveBeenCalledWith('Fede')
    expect(sent.buttons.at(-1)?.bodyText).toContain('Fede')
    expect(sent.buttons.at(-1)?.bodyText).not.toContain('5491100000000')
  })

  it('la cotización aplica el glosario (moldura = grosor) igual que la creación', async () => {
    const db = makeDb([
      { term_norm: 'moldura', term_display: 'moldura', meaning: { type: 'grosor', value: 4 } },
    ])
    const parseFn = async () => ({
      cliente: null,
      items: [{ cantidad: 1, texto: 'moldura de 4 56x41 sin tela' }],
    })

    await processPedidoMessage(args(db, 'moldura de 4 56x41 sin tela', { parseFn }))

    expect(sent.texts.at(-1)).toContain('Cotización estimada:')
    expect(sent.texts.at(-1)).toContain('20.000')
    expect(sent.texts.at(-1)).not.toContain('Sin cotizar')
  })

  it('la cotización pregunta por un término desconocido que bloquea y espera el glosario', async () => {
    const db = makeDb()
    const parseFn = async () => ({
      cliente: null,
      items: [{ cantidad: 1, texto: 'pantalla para embastar' }],
    })

    const result = await processPedidoMessage(args(db, 'pantalla para embastar', { parseFn }))

    expect(result.handled).toBe(true)
    expect(sent.texts.at(-1)).toContain('necesito entender')
    expect(sent.texts.at(-1)).toContain('pantalla')
    expect((db as ReturnType<typeof makeDb>).getOrderContext()).toMatchObject({
      awaitingQuoteApproval: true,
      awaitingGlossary: { terms: ['pantalla'] },
    })
  })

  it('no toma el nombre del saludo como cliente en la cotización', async () => {
    const db = makeDb()
    const parseFn = async () => ({
      cliente: 'Jorge',
      items: [{ cantidad: 4, texto: 'pintura 94x81' }],
    })

    await processPedidoMessage(
      args(db, 'Hola Jorge, tengo 4 pinturas para embastar', { parseFn }),
    )

    expect(sent.texts.at(-1)).toContain('Cotización estimada:')
    expect(sent.texts.at(-1)).not.toContain('Jorge')
    expect((db as ReturnType<typeof makeDb>).getOrderContext()).toMatchObject({
      clienteNombre: null,
    })
  })

  it('no usa el nombre del saludo como cliente al crear (pregunta a nombre de quién)', async () => {
    const db = makeDb()
    const parseFn = async () => ({
      cliente: 'Jorge',
      items: [{ cantidad: 1, texto: 'bastidor sin tela 60x40' }],
    })

    await processPedidoMessage(
      args(db, 'Hola Jorge, armame un presupuesto 60x40', { parseFn }),
    )

    expect(sent.texts.at(-1)).toContain('¿A nombre de quién armo el presupuesto?')
    expect(sent.texts.at(-1)).not.toContain('Jorge')
  })
})
