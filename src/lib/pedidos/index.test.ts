import { describe, it, expect, vi, beforeEach } from 'vitest'

const facbal = vi.hoisted(() => ({
  createInvoice: vi.fn(),
  nextInvoiceNumber: vi.fn(),
  searchClients: vi.fn(),
  createClient: vi.fn(),
  findClientMatches: vi.fn(),
  getPreciosReferencia: vi.fn(),
  getPricingRules: vi.fn(),
  getClientAddresses: vi.fn(),
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

const ai = vi.hoisted(() => ({ callOpenRouter: vi.fn() }))
vi.mock('@/lib/ai/openrouter', () => ai)

import { processPedidoMessage, mergePreservedItems } from './index'
import type { PedidoItem } from './types'
import { preciosReferencia, pricingRules } from '../precios/__fixtures__/catalogo'

function makeDb(glossaryRows: unknown[] = []) {
  const state: { order: unknown; glossary: unknown[] } = { order: null, glossary: glossaryRows }
  const db = {
    from(table: string) {
      if (table === 'order_glossary') {
        return {
          select: () => ({ eq: async () => ({ data: state.glossary }) }),
          upsert: async (row: { term_norm?: string }) => {
            state.glossary = state.glossary.filter(
              r => (r as { term_norm?: string }).term_norm !== row.term_norm,
            )
            state.glossary.push(row)
            return { error: null }
          },
        }
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
  return Object.assign(db as any, {
    getOrderContext: () => state.order,
    getGlossary: () => state.glossary,
    setGlossary: (rows: unknown[]) => {
      state.glossary = rows
    },
  })
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
    ai.callOpenRouter.mockReset()
    ai.callOpenRouter.mockResolvedValue({
      text: JSON.stringify({ meanings: [{ term: 'moldura', type: 'grosor', value: 4 }] }),
    })
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
    facbal.getClientAddresses.mockResolvedValue([])
  })

  it('pide cliente, luego todo junto (entrega+fecha+descuento) y crea', async () => {
    const db = makeDb()

    // 1. Creación explícita → confirma el cliente encontrado.
    await processPedidoMessage(args(db, 'Armame un presupuesto: 2 bastidores 60x40 sin tela'))
    expect(sent.buttons.at(-1)?.bodyText).toContain('Juan')

    // 2. Confirmar cliente → UNA pregunta combinada (Caso 3), no confirmación directa.
    await processPedidoMessage(args(db, '', { interactiveReplyId: 'pedido_cli_ok' }))
    expect(sent.texts.at(-1)).toContain('Entrega')
    expect(sent.texts.at(-1)).toContain('Fecha')
    expect(sent.texts.at(-1)).toContain('Descuento')
    expect(sent.texts.at(-1)).not.toContain('¿Confirmás?')

    // 3. Responde todo junto → resumen final con ¿Confirmás?
    ai.callOpenRouter.mockResolvedValueOnce({
      text: JSON.stringify({ tipo_entrega: 'Retira', fecha: 'no', descuento: 'no', domicilio: null }),
    })
    await processPedidoMessage(args(db, 'retira, sin fecha y sin descuento'))
    expect(sent.texts.at(-1)).toMatch(/¿Confirmás\?/)
    expect(sent.texts.at(-1)).toContain('Entrega: Retira')

    // 4. Confirmar → crea el presupuesto.
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

  it('con varias direcciones las propone y guarda la elegida (Caso 3c)', async () => {
    const db = makeDb()
    const findClientsFn = vi.fn(async () => [{ id: 9, nombre: 'Lucas', telefono: '3512390977', score: 0.9 }])
    facbal.getClientAddresses.mockResolvedValue([
      { id: 1, address: 'Taller Centro', label: '', extra: '', is_default: true },
      { id: 2, address: 'Depósito Sur', label: '', extra: '', is_default: false },
    ])

    await processPedidoMessage(args(db, 'Armame un presupuesto: 2 bastidores 60x40 sin tela', { findClientsFn }))
    await processPedidoMessage(args(db, '', { interactiveReplyId: 'pedido_cli_ok', findClientsFn }))
    expect(sent.texts.at(-1)).toContain('Taller Centro')
    expect(sent.texts.at(-1)).toContain('Depósito Sur')

    ai.callOpenRouter.mockResolvedValueOnce({
      text: JSON.stringify({ tipo_entrega: 'Envio', fecha: 'no', descuento: 'no', domicilio: 'Depósito Sur' }),
    })
    await processPedidoMessage(args(db, 'envío al depósito sur, sin fecha y sin descuento', { findClientsFn }))
    expect(sent.texts.at(-1)).toContain('Domicilio: Depósito Sur')
    expect(sent.texts.at(-1)).toMatch(/¿Confirmás\?/)

    await processPedidoMessage(args(db, 'sí', { findClientsFn }))
    const payload = facbal.createInvoice.mock.calls[0][0] as {
      tipo_entrega: string
      cliente_domicilio: string
    }
    expect(payload.tipo_entrega).toBe('Envio')
    expect(payload.cliente_domicilio).toBe('Depósito Sur')
  })

  it('sin candidatos pregunta datos combinados y luego crea (Caso 3)', async () => {
    const db = makeDb()
    await processPedidoMessage(
      args(db, 'Armame un presupuesto: 2 bastidores 60x40 sin tela', { findClientsFn: async () => [] }),
    )
    expect(sent.texts.at(-1)).toContain('Cliente nuevo: Juan')
    expect(sent.texts.at(-1)).toContain('Entrega')
    expect(sent.texts.at(-1)).not.toContain('¿Confirmás?')

    ai.callOpenRouter.mockResolvedValueOnce({
      text: JSON.stringify({ tipo_entrega: 'Retira', fecha: 'no', descuento: 'no', domicilio: null }),
    })
    await processPedidoMessage(args(db, 'retira, sin fecha y sin descuento', { findClientsFn: async () => [] }))
    expect(sent.texts.at(-1)).toMatch(/¿Confirmás\?/)

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

  it('"no lo creas, era una prueba" descarta la cotización (soft-cancel) sin buscar clientes ni escribir', async () => {
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

    expect(result.text).toContain('No la guardé ni creé nada')
    expect((db as ReturnType<typeof makeDb>).getOrderContext()).toMatchObject({
      quoteCancelled: true,
      awaitingQuoteApproval: false,
    })
    expect(findClientsFn).not.toHaveBeenCalled()
    expect(facbal.createClient).not.toHaveBeenCalled()
    expect(facbal.createInvoice).not.toHaveBeenCalled()
  })

  it('tras descartar, "perdón, sí, hacelo" reanuda la cotización (incidente 15/10)', async () => {
    const db = makeDb()
    const findClientsFn = vi.fn(async () => [])
    const parseFn = async () => ({
      cliente: null,
      items: [{ cantidad: 1, texto: 'bastidor 20x20 lienzo profesional' }],
    })

    await processPedidoMessage(args(db, 'Quería saber si tienen bastidores de 20x20', { parseFn, findClientsFn }))
    await processPedidoMessage(args(db, 'no lo creas, era una prueba', { parseFn, findClientsFn }))
    expect((db as ReturnType<typeof makeDb>).getOrderContext()).toMatchObject({ quoteCancelled: true })

    // El LLM juzga la respuesta natural como confirmación (retomar).
    ai.callOpenRouter.mockResolvedValueOnce({ text: JSON.stringify({ decision: 'confirm' }) })
    const result = await processPedidoMessage(
      args(db, 'perdon, si quiero que llo hagas presupuesto', { parseFn, findClientsFn }),
    )

    expect(result.handled).toBe(true)
    expect(sent.texts.at(-1)).toContain('¿A nombre de quién armo el presupuesto?')
    const ctx = (db as ReturnType<typeof makeDb>).getOrderContext() as { quoteCancelled?: boolean }
    expect(ctx.quoteCancelled).toBeFalsy()
    expect(facbal.createInvoice).not.toHaveBeenCalled()
  })

  it('descartar de nuevo sobre una cotización descartada la borra del todo', async () => {
    const db = makeDb()
    const findClientsFn = vi.fn(async () => [])
    const parseFn = async () => ({
      cliente: null,
      items: [{ cantidad: 1, texto: 'bastidor 20x20 lienzo profesional' }],
    })

    await processPedidoMessage(args(db, 'Quería saber si tienen bastidores de 20x20', { parseFn, findClientsFn }))
    await processPedidoMessage(args(db, 'no lo creas, era una prueba', { parseFn, findClientsFn }))

    const result = await processPedidoMessage(args(db, 'cancelar', { parseFn, findClientsFn }))
    expect(result.text).toContain('descarté del todo')
    expect((db as ReturnType<typeof makeDb>).getOrderContext()).toEqual({})
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

  it('al aceptar una cotización pide cliente, luego todo junto, y crea', async () => {
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

    // Cliente nuevo (sin candidatos) → pregunta combinada, no confirmación.
    await processPedidoMessage(args(db, 'Fede', { parseFn, findClientsFn }))
    expect(sent.texts.at(-1)).toContain('Entrega')
    expect(sent.texts.at(-1)).not.toContain('¿Confirmás?')
    expect(facbal.createInvoice).not.toHaveBeenCalled()

    // Todo junto con fecha, descuento y domicilio nuevo → resumen → crear.
    ai.callOpenRouter.mockResolvedValueOnce({
      text: JSON.stringify({
        tipo_entrega: 'Envio',
        fecha: '15/11',
        descuento: { mode: 'percent', value: 10 },
        domicilio: 'Av Siempre Viva 123',
      }),
    })
    await processPedidoMessage(args(db, 'envío para el 15/11 al taller de siempre viva 123 con 10%', { parseFn, findClientsFn }))
    expect(sent.texts.at(-1)).toMatch(/¿Confirmás\?/)
    expect(sent.texts.at(-1)).toContain('Domicilio: Av Siempre Viva 123')

    const result = await processPedidoMessage(args(db, 'sí', { parseFn, findClientsFn }))
    expect(result.createdInvoice).toBeTruthy()
    expect(facbal.createClient).toHaveBeenCalledWith({ nombre: 'Fede' })
    expect(facbal.createInvoice).toHaveBeenCalledTimes(1)
    const payload = facbal.createInvoice.mock.calls[0][0] as {
      tipo_entrega: string
      fecha_entrega: string
      cliente_domicilio: string
      items: { descripcion: string }[]
    }
    expect(payload.tipo_entrega).toBe('Envio')
    expect(payload.cliente_domicilio).toBe('Av Siempre Viva 123')
    expect(payload.items.some(i => i.descripcion === 'DESCUENTO')).toBe(true)
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
      awaitingDatos: true,
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
      items: [{ cantidad: 1, texto: 'florero' }],
    })

    const result = await processPedidoMessage(args(db, 'florero', { parseFn }))

    expect(result.handled).toBe(true)
    expect(sent.texts.at(-1)).toContain('necesito entender')
    expect(sent.texts.at(-1)).toContain('florero')
    expect((db as ReturnType<typeof makeDb>).getOrderContext()).toMatchObject({
      awaitingQuoteApproval: true,
      awaitingGlossary: { terms: ['florero'] },
    })
  })

  it('cotiza un producto por atributo cuando el texto ya lo determina (rollo de tela)', async () => {
    const db = makeDb()
    const parseFn = async () => ({
      cliente: null,
      items: [{ cantidad: 1, texto: 'rollo de tela' }],
    })

    await processPedidoMessage(args(db, 'agregá un rollo de tela', { parseFn }))

    expect(sent.texts.at(-1)).toContain('Cotización estimada:')
    expect(sent.texts.at(-1)).toContain('197.000')
    expect(sent.texts.at(-1)).not.toContain('Sin cotizar')
  })

  it('no contamina el rollo de tela con una variante arrastrada del contexto', async () => {
    const db = makeDb()
    // Simula el LLM que reemite el ítem nuevo con "sin tela" pegado del contexto.
    const parseFn = async () => ({
      cliente: null,
      items: [{ cantidad: 1, texto: 'rollo de tela 2x5 sin tela' }],
    })

    await processPedidoMessage(args(db, 'agregá un rollo de tela 2x5', { parseFn }))

    expect(sent.texts.at(-1)).toContain('197.000')
    expect(sent.texts.at(-1)).not.toContain('Sin cotizar')
  })

  it('pregunta medida y variante de acrílico con opciones del catálogo y cotiza', async () => {
    const db = makeDb()
    const parseFn = async () => ({
      cliente: null,
      items: [{ cantidad: 1, texto: 'acrilico' }],
    })

    // 1. Pide la medida con opciones del catálogo (60cc/125cc/...).
    await processPedidoMessage(args(db, 'acrilico', { parseFn }))
    expect(sent.texts.at(-1)).toContain('¿Qué medida de "acrilico"?')
    expect(sent.texts.at(-1)).toContain('60cc')
    expect((db as ReturnType<typeof makeDb>).getOrderContext()).toMatchObject({
      awaitingQuoteApproval: true,
      awaitingItemAttr: { ask: 'medida' },
    })

    // 2. Elige 60cc (opción 1) → pide la variante.
    await processPedidoMessage(args(db, '1', { parseFn }))
    expect(sent.texts.at(-1)).toContain('¿Qué variante de "acrilico 60cc"?')
    expect(sent.texts.at(-1)).toContain('Comunes')
    expect((db as ReturnType<typeof makeDb>).getOrderContext()).toMatchObject({
      awaitingItemAttr: { ask: 'variante' },
    })

    // 3. Elige Comunes → cotiza 60cc Comunes = $7.500.
    await processPedidoMessage(args(db, 'Comunes', { parseFn }))
    expect(sent.texts.at(-1)).toContain('Cotización estimada:')
    expect(sent.texts.at(-1)).toContain('7.500')
    expect(sent.texts.at(-1)).not.toContain('Sin cotizar')
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

  it('"revisá el glosario" reprocesa la cotización con el glosario actualizado', async () => {
    const db = makeDb()
    const parseFn = async () => ({
      cliente: null,
      items: [{ cantidad: 1, texto: 'moldura de 4 56x41 sin tela' }],
    })

    await processPedidoMessage(args(db, 'moldura de 4 56x41 sin tela', { parseFn }))
    expect(sent.texts.at(-1)).toContain('18.000')

    // El usuario agrega el término al glosario (pantalla) y pide revisarlo.
    db.setGlossary([{ term_norm: 'moldura', term_display: 'moldura', meaning: { type: 'grosor', value: 4 } }])
    await processPedidoMessage(args(db, 'revisá el glosario', { parseFn }))

    expect(sent.texts.at(-1)).toContain('Cotización estimada:')
    expect(sent.texts.at(-1)).toContain('20.000')
  })

  it('aprende una definición en línea y reprocesa el pedido pendiente', async () => {
    const db = makeDb()
    const parseFn = async () => ({
      cliente: null,
      items: [{ cantidad: 1, texto: 'moldura de 4 56x41 sin tela' }],
    })

    await processPedidoMessage(args(db, 'moldura de 4 56x41 sin tela', { parseFn }))
    expect(sent.texts.at(-1)).toContain('18.000')

    await processPedidoMessage(args(db, 'revisá el glosario, moldura significa grosor', { parseFn }))

    expect(ai.callOpenRouter).toHaveBeenCalled()
    expect(sent.texts.at(-1)).toContain('Cotización estimada:')
    expect(sent.texts.at(-1)).toContain('20.000')
  })

  it('un producto fuera de catálogo se cotiza como línea manual (sin alucinar bastidores)', async () => {
    const db = makeDb()
    const parseFn = async () => ({
      cliente: 'Jesus',
      items: [
        { cantidad: 2, texto: 'bastidor 40x89' },
        { cantidad: 1, texto: 'palos de metal', precio: 0 },
      ],
    })

    await processPedidoMessage(
      args(db, 'cuánto salen para Jesus 2 bastidores 40 x 89 y Palos de metal a 0 pesos', { parseFn }),
    )

    const t = sent.texts.at(-1)!
    expect(t).toContain('Cotización estimada:')
    expect(t).toContain('Palos de metal (manual)')
    // El ítem libre NO se convierte en un bastidor extra.
    expect((t.match(/BASTIDOR/g) || []).length).toBe(1)
    expect((db as ReturnType<typeof makeDb>).getOrderContext()).not.toMatchObject({
      awaitingGlossary: expect.anything(),
    })
  })

  it('permite cotizar a mano: le da precio a un ítem "a cotizar" por nombre', async () => {
    const db = makeDb()
    const parseFn = async () => ({
      cliente: 'Jesus',
      items: [
        { cantidad: 2, texto: 'bastidor 40x89' },
        { cantidad: 1, texto: 'palos de metal' },
      ],
    })

    await processPedidoMessage(args(db, 'cuánto salen 2 bastidores 40x89 y palos de metal', { parseFn }))
    expect(sent.texts.at(-1)).toContain('Sin cotizar')
    expect(sent.texts.at(-1)).toContain('palos de metal')

    const modifyFn = async () => ({
      kind: 'ops' as const,
      ops: [{ op: 'set_price' as const, target: { text: 'palos de metal' }, mode: 'absolute' as const, value: 5000 }],
    })
    await processPedidoMessage(args(db, 'el palos de metal vale 5000', { parseFn, modifyFn }))

    expect(sent.texts.at(-1)).toContain('Cotización actualizada:')
    expect(sent.texts.at(-1)).toContain('Palos de metal (manual) — $5.000')
    expect(sent.texts.at(-1)).not.toContain('Sin cotizar')
  })

  it('creación corta: una sola pregunta de datos y asume sin fecha/descuento', async () => {
    const db = makeDb()
    const parseFn = async () => ({
      cliente: 'Fede',
      items: [{ cantidad: 1, texto: 'bastidor sin tela 60x40' }],
    })
    const findClientsFn = vi.fn(async () => [])

    await processPedidoMessage(args(db, 'Armame un presupuesto para Fede 60x40', { parseFn, findClientsFn }))
    // Falta entrega → UNA pregunta combinada.
    expect(sent.texts.at(-1)).toContain('Entrega')

    ai.callOpenRouter.mockResolvedValueOnce({
      text: JSON.stringify({ cliente: null, tipo_entrega: 'Retira', fecha: null, descuento: null, domicilio: null }),
    })
    await processPedidoMessage(args(db, 'retira', { parseFn, findClientsFn }))
    // Asume sin fecha y sin descuento → resumen directo.
    expect(sent.texts.at(-1)).toContain('¿Confirmás?')
    expect(sent.texts.at(-1)).toContain('Entrega: Retira')
    expect(sent.texts.at(-1)).not.toContain('Fecha de entrega')

    const r = await processPedidoMessage(args(db, 'sí', { parseFn, findClientsFn }))
    expect(r.createdInvoice).toBeTruthy()
    const payload = facbal.createInvoice.mock.calls[0][0] as {
      tipo_entrega: string
      fecha_entrega: string
      items: { descripcion: string }[]
    }
    expect(payload.tipo_entrega).toBe('Retira')
    expect(payload.fecha_entrega).toBe('')
    expect(payload.items.some(i => i.descripcion === 'DESCUENTO')).toBe(false)
  })

  it('toma cliente y entrega de una sola respuesta', async () => {
    const db = makeDb()
    const parseFn = async () => ({
      cliente: null,
      items: [{ cantidad: 2, texto: 'bastidor sin tela 60x40' }],
    })
    const findClientsFn = vi.fn(async () => [])

    await processPedidoMessage(
      args(db, 'Armame un presupuesto: 2 bastidores 60x40 sin tela', { parseFn, findClientsFn }),
    )
    expect(sent.texts.at(-1)).toContain('¿A nombre de quién armo el presupuesto?')

    ai.callOpenRouter.mockResolvedValueOnce({
      text: JSON.stringify({
        cliente: 'Fede',
        tipo_entrega: 'Envio',
        fecha: null,
        descuento: null,
        domicilio: 'Av Siempre Viva 123',
      }),
    })
    await processPedidoMessage(
      args(db, 'a nombre de Fede y es envío a Av Siempre Viva 123', { parseFn, findClientsFn }),
    )

    expect(sent.texts.at(-1)).toContain('Cliente nuevo: Fede')
    expect(sent.texts.at(-1)).toContain('Entrega: Envio')
    expect(sent.texts.at(-1)).toContain('Domicilio: Av Siempre Viva 123')
  })
})

describe('processPedidoMessage - modificacion de linea en cotizacion abierta', () => {
  beforeEach(() => {
    sent.texts = []
    sent.buttons = []
    ai.callOpenRouter.mockReset()
    ai.callOpenRouter.mockResolvedValue({
      text: JSON.stringify({ meanings: [{ term: 'moldura', type: 'grosor', value: 4 }] }),
    })
    facbal.nextInvoiceNumber.mockResolvedValue('F-1001')
  })

  const parseBastidor = async () => ({
    cliente: null,
    items: [{ cantidad: 1, texto: 'bastidor 60x60 sin tela' }],
  })

  it('aplica 10% a la linea via fast-path y re-presenta sin crear', async () => {
    const db = makeDb()
    await processPedidoMessage(args(db, 'bastidor 60x60 sin tela', { parseFn: parseBastidor }))
    expect(sent.texts.at(-1)).toContain('Cotizaci')
    expect(sent.texts.at(-1)).toContain('21.000')

    const result = await processPedidoMessage(
      args(db, 'a la línea 1 hacele 10%', { parseFn: parseBastidor }),
    )
    expect(result.handled).toBe(true)
    expect(sent.texts.at(-1)).toContain('Cotización actualizada:')
    expect(sent.texts.at(-1)).toContain('Apliqué 10% a la línea 1')
    expect(sent.texts.at(-1)).toContain('19.000')
    expect(sent.texts.at(-1)).toContain('TOTAL: $19.000')
    expect(facbal.createInvoice).not.toHaveBeenCalled()
    expect((db as ReturnType<typeof makeDb>).getOrderContext()).toMatchObject({
      awaitingQuoteApproval: true,
    })
  })

  it('modifyFn inyectado: saca la linea 2 de 2 y re-presenta', async () => {
    const db = makeDb()
    const parseDos = async () => ({
      cliente: null,
      items: [
        { cantidad: 1, texto: 'bastidor 60x60 sin tela' },
        { cantidad: 1, texto: 'bastidor 30x30 sin tela' },
      ],
    })
    await processPedidoMessage(args(db, 'dos bastidores', { parseFn: parseDos }))
    expect(sent.texts.at(-1)).toContain('Cotizaci')

    const modifyFn = async () => ({ kind: 'ops' as const, ops: [{ op: 'remove' as const, target: 2 }] })
    const result = await processPedidoMessage(
      args(db, 'saca el segundo', { parseFn: parseDos, modifyFn }),
    )
    expect(result.handled).toBe(true)
    expect(sent.texts.at(-1)).toContain('Cotizaci')
    expect(facbal.createInvoice).not.toHaveBeenCalled()
  })

  it('set_price: cambia el precio de una línea por nombre (intérprete general)', async () => {
    const db = makeDb()
    await processPedidoMessage(args(db, 'bastidor 60x60 sin tela', { parseFn: parseBastidor }))

    const modifyFn = async () => ({
      kind: 'ops' as const,
      ops: [{ op: 'set_price' as const, target: 1, mode: 'absolute' as const, value: 300000 }],
    })
    const result = await processPedidoMessage(
      args(db, 'cambiale el precio al bastidor de 142 x 195 a 300mil', { parseFn: parseBastidor, modifyFn }),
    )

    expect(result.handled).toBe(true)
    expect(sent.texts.at(-1)).toContain('Cotización actualizada:')
    expect(sent.texts.at(-1)).toContain('300.000')
    expect(facbal.createInvoice).not.toHaveBeenCalled()
  })

  it('un cambio que no puede aplicar lo dice sin repetir y sin escribir', async () => {
    const db = makeDb()
    await processPedidoMessage(args(db, 'bastidor 60x60 sin tela', { parseFn: parseBastidor }))

    const modifyFn = async () => ({ kind: 'unsupported' as const, motivo: 'no sé a qué línea' })
    const result = await processPedidoMessage(
      args(db, 'cambiale el precio a esa', { parseFn: parseBastidor, modifyFn }),
    )

    expect(result.handled).toBe(true)
    expect(sent.texts.at(-1)).toContain('No pude aplicar ese cambio')
    expect((db as ReturnType<typeof makeDb>).getOrderContext()).toMatchObject({
      awaitingQuoteApproval: true,
    })
    expect(facbal.createInvoice).not.toHaveBeenCalled()
  })
})

describe('regresiones c9d6f97 / 010cfe8 (Fase 1)', () => {
  beforeEach(() => {
    sent.texts = []
    sent.buttons = []
    ai.callOpenRouter.mockReset()
    ai.callOpenRouter.mockResolvedValue({
      text: JSON.stringify({ meanings: [{ term: 'moldura', type: 'grosor', value: 4 }] }),
    })
    facbal.nextInvoiceNumber.mockResolvedValue('F-1001')
    facbal.getClientAddresses.mockResolvedValue([])
  })

  it('una cotización descartada NO contamina un pedido nuevo (no arrastra ítems ni cliente)', async () => {
    const db = makeDb()
    const viejo = async () => ({
      cliente: 'Jesus',
      items: [
        { cantidad: 2, texto: 'bastidor 40x89' },
        { cantidad: 1, texto: 'bastidor 60x60' },
      ],
    })
    await processPedidoMessage(args(db, 'dos bastidores 40x89 y uno 60x60 para Jesus', { parseFn: viejo }))
    await processPedidoMessage(args(db, 'no lo creas, era una prueba', { parseFn: viejo }))
    expect((db as ReturnType<typeof makeDb>).getOrderContext()).toMatchObject({ quoteCancelled: true })

    const nuevo = async () => ({ cliente: null, items: [{ cantidad: 2, texto: 'bastidor 200x140 sin tela' }] })
    const result = await processPedidoMessage(args(db, 'Sin lienzo: 200x140cm (x2)', { parseFn: nuevo }))

    expect(result.handled).toBe(true)
    expect(sent.texts.at(-1)).toContain('Cotización estimada')
    const ctx = (db as ReturnType<typeof makeDb>).getOrderContext() as {
      items: { descripcion: string }[]
      clienteNombre: string | null
      quoteText?: string | null
    }
    expect(ctx.items).toHaveLength(1)
    expect(ctx.items[0].descripcion).toContain('Sin Tela')
    expect(JSON.stringify(ctx.items)).not.toContain('40 x 89')
    expect(JSON.stringify(ctx.items)).not.toContain('60 x 60')
    expect(ctx.clienteNombre).not.toBe('Jesus')
    expect(ctx.quoteText ?? '').not.toContain('40x89')
  })

  it('un pedido nuevo que dice "cambiar el pedido" tampoco se fusiona con la cotización descartada', async () => {
    const db = makeDb()
    const viejo = async () => ({
      cliente: 'Jesus',
      items: [
        { cantidad: 2, texto: 'bastidor 40x89' },
        { cantidad: 1, texto: 'bastidor 60x60' },
      ],
    })
    await processPedidoMessage(args(db, 'dos bastidores 40x89 y uno 60x60 para Jesus', { parseFn: viejo }))
    await processPedidoMessage(args(db, 'no lo creas, era una prueba', { parseFn: viejo }))
    expect((db as ReturnType<typeof makeDb>).getOrderContext()).toMatchObject({ quoteCancelled: true })

    const nuevo = async () => ({ cliente: null, items: [{ cantidad: 8, texto: 'bastidor 240x120 con lienzo profesional' }] })
    await processPedidoMessage(args(db, 'Bueno tuve q cambiar el pedido, les paso el nuevo: Con lienzo: 240x120cm (x8)', { parseFn: nuevo }))

    const ctx = (db as ReturnType<typeof makeDb>).getOrderContext() as {
      items: { descripcion: string }[]
      quoteText?: string | null
    }
    expect(ctx.items).toHaveLength(1)
    expect(JSON.stringify(ctx.items)).not.toContain('40 x 89')
    expect(JSON.stringify(ctx.items)).not.toContain('60 x 60')
    expect(ctx.quoteText ?? '').not.toContain('40x89')
  })

  it('conserva el precio editado a mano al agregar un ítem y completar su atributo', async () => {
    const db = makeDb()
    const parseFn = async (text: string) => ({
      cliente: null,
      items: [
        { cantidad: 2, texto: 'bastidor 40x89' },
        ...(text.includes('acrilico') ? [{ cantidad: 1, texto: 'acrilico' }] : []),
      ],
    })

    // 1. Cotización con 2x BASTIDOR 40x89.
    await processPedidoMessage(args(db, '2 bastidores 40x89', { parseFn }))
    expect(sent.texts.at(-1)).toContain('Cotización estimada')

    // 2. El usuario baja la línea 1 a $20.000 (edición manual de precio).
    const modifyPrecio = async () => ({
      kind: 'ops' as const,
      ops: [{ op: 'set_price' as const, target: 1, mode: 'absolute' as const, value: 20000 }],
    })
    await processPedidoMessage(args(db, 'la línea 1 a 20000', { parseFn, modifyFn: modifyPrecio }))
    let ctx = (db as ReturnType<typeof makeDb>).getOrderContext() as {
      items: { descripcion: string; precio_unitario: number | null }[]
      total?: number
    }
    expect(ctx.items[0].precio_unitario).toBe(20000)

    // 3. "agrega un acrilico" → pide medida (intérprete general → none).
    const modifyNone = async () => ({ kind: 'none' as const })
    await processPedidoMessage(args(db, 'agrega un acrilico', { parseFn, modifyFn: modifyNone }))
    expect(sent.texts.at(-1)).toContain('acrilico')

    // 4. "250cc" → pide variante.
    await processPedidoMessage(args(db, '250cc', { parseFn }))
    // 5. "serie 1" → cotiza el acrílico conservando el $20.000 de la línea 1.
    await processPedidoMessage(args(db, 'serie 1', { parseFn }))

    ctx = (db as ReturnType<typeof makeDb>).getOrderContext() as {
      items: { descripcion: string; precio_unitario: number | null }[]
      total: number
    }
    expect(ctx.items[0].precio_unitario).toBe(20000)
    const acrilico = ctx.items.find((it) => it.descripcion.toLowerCase().includes('acrilico'))
    expect(acrilico?.precio_unitario).toBe(19000)
    expect(ctx.total).toBe(2 * 20000 + 19000)
    expect(facbal.createInvoice).not.toHaveBeenCalled()
  })
})

describe('Fase 3 — fin de trampas modales (muestra sin medida / glosario libre)', () => {
  beforeEach(() => {
    sent.texts = []
    sent.buttons = []
    ai.callOpenRouter.mockReset()
    ai.callOpenRouter.mockResolvedValue({
      text: JSON.stringify({ meanings: [{ term: 'moldura', type: 'grosor', value: 4 }] }),
    })
    facbal.nextInvoiceNumber.mockResolvedValue('F-1001')
    facbal.getClientAddresses.mockResolvedValue([])
  })

  it('"sin medida" sale de awaitingItemAttr como línea manual (sin loop "Necesito una medida")', async () => {
    const db = makeDb()
    const parseFn = vi.fn(async (text: string) =>
      text.includes('sin medida')
        ? { cliente: null, items: [{ cantidad: 1, texto: 'Bastidor de Muestra con Fibro', libre: true }] }
        : { cliente: null, items: [{ cantidad: 1, texto: 'Bastidor de Muestra con Fibro' }] },
    )

    await processPedidoMessage(args(db, 'y un Bastidor de Muestra con Fibro', { parseFn }))
    expect(sent.texts.at(-1)).toContain('¿Qué medida para')
    expect((db as ReturnType<typeof makeDb>).getOrderContext()).toMatchObject({
      awaitingItemAttr: { ask: 'medida' },
    })

    await processPedidoMessage(args(db, 'sin medida', { parseFn }))
    expect(sent.texts.at(-1)).not.toContain('Necesito una medida')
    expect(sent.texts.at(-1)).toContain('Bastidor de Muestra con Fibro')
    expect(sent.texts.at(-1)).toContain('Sin cotizar')
    const ctxFinal = (db as ReturnType<typeof makeDb>).getOrderContext() as { awaitingItemAttr?: unknown }
    expect(ctxFinal.awaitingItemAttr ?? null).toBeNull()
  })

  it('frase rica "es gratis" resuelve el ítem libre a $0 sin volver a preguntar', async () => {
    const db = makeDb()
    const parseFn = vi.fn(async (text: string) =>
      text.includes('gratis')
        ? { cliente: null, items: [{ cantidad: 1, texto: 'Muestra con Fibro', libre: true, precio: 0 }] }
        : { cliente: null, items: [{ cantidad: 1, texto: 'Bastidor de Muestra con Fibro' }] },
    )

    await processPedidoMessage(args(db, 'y un Bastidor de Muestra con Fibro', { parseFn }))
    await processPedidoMessage(args(db, 'no tiene medida y es gratis', { parseFn }))

    expect(sent.texts.at(-1)).not.toContain('Necesito una medida')
    expect(sent.texts.at(-1)).toContain('Muestra con Fibro (manual) — $0')
    expect((db as ReturnType<typeof makeDb>).getOrderContext()).not.toMatchObject({
      awaitingItemAttr: expect.anything(),
    })
  })

  it('glosario sin términos reconocidos ("es un producto fuera de catálogo") → ítem libre, sin guardar glosario', async () => {
    const db = makeDb()
    const parseFn = async () => ({ cliente: null, items: [{ cantidad: 1, texto: 'florero' }] })

    await processPedidoMessage(args(db, 'florero', { parseFn }))
    expect(sent.texts.at(-1)).toContain('necesito entender')
    expect((db as ReturnType<typeof makeDb>).getOrderContext()).toMatchObject({
      awaitingGlossary: { terms: ['florero'] },
    })

    ai.callOpenRouter.mockResolvedValueOnce({ text: JSON.stringify({ meanings: [] }) })
    await processPedidoMessage(
      args(db, 'no son términos, es un producto que no está en el catálogo', { parseFn }),
    )

    expect(sent.texts.at(-1)).not.toContain('necesito entender')
    expect(sent.texts.at(-1)).toContain('Sin cotizar')
    expect(sent.texts.at(-1)).toContain('florero')
    expect((db as ReturnType<typeof makeDb>).getGlossary()).toEqual([])
  })
})

describe('Fase 5 — candidatos de cliente, ítems sin precio y escape de Gastos', () => {
  beforeEach(() => {
    sent.texts = []
    sent.buttons = []
    ai.callOpenRouter.mockReset()
    ai.callOpenRouter.mockResolvedValue({
      text: JSON.stringify({ meanings: [{ term: 'moldura', type: 'grosor', value: 4 }] }),
    })
    facbal.nextInvoiceNumber.mockResolvedValue('F-1001')
    facbal.getClientAddresses.mockResolvedValue([])
  })

  it('elige el candidato por nombre con typo ("Pachecho") sin crear un cliente nuevo', async () => {
    const db = makeDb()
    const findClientsFn = vi.fn(async () => [
      { id: 1, nombre: 'Cesar Details', telefono: null, score: 0.9 },
      { id: 2, nombre: 'Cesar Pacheco', telefono: null, score: 0.8 },
    ])
    const parseFn = async () => ({
      cliente: 'Cesar',
      items: [{ cantidad: 1, texto: 'bastidor 60x60 sin tela' }],
    })

    await processPedidoMessage(args(db, 'Armame un presupuesto para Cesar 60x60', { parseFn, findClientsFn }))
    expect(sent.texts.at(-1)).toContain('Encontré varios clientes')

    await processPedidoMessage(args(db, 'Pachecho', { parseFn, findClientsFn }))
    expect(sent.texts.at(-1)).toContain('Entrega')
    expect((db as ReturnType<typeof makeDb>).getOrderContext()).toMatchObject({ clienteId: 2 })
    expect(facbal.createClient).not.toHaveBeenCalled()
  })

  it('pregunta por ítems sin precio antes de crear; "seguí" continúa sin bloquear', async () => {
    const db = makeDb()
    const parseFn = async () => ({
      cliente: null,
      items: [
        { cantidad: 2, texto: 'bastidor 40x89' },
        { cantidad: 1, texto: 'palos de metal' },
      ],
    })

    await processPedidoMessage(args(db, '2 bastidores 40x89 y palos de metal', { parseFn }))
    expect(sent.texts.at(-1)).toContain('Sin cotizar')

    ai.callOpenRouter.mockResolvedValueOnce({ text: JSON.stringify({ decision: 'confirm' }) })
    await processPedidoMessage(args(db, 'si conviertelo', { parseFn }))
    expect(sent.texts.at(-1)).toContain('sin precio')
    expect(sent.texts.at(-1)).toContain('sacalo')
    expect(facbal.createInvoice).not.toHaveBeenCalled()
    expect((db as ReturnType<typeof makeDb>).getOrderContext()).toMatchObject({ awaitingFaltante: true })

    await processPedidoMessage(args(db, 'segui', { parseFn }))
    expect((db as ReturnType<typeof makeDb>).getOrderContext()).not.toMatchObject({ awaitingFaltante: true })
    expect(sent.texts.at(-1)).toContain('¿A nombre de quién armo el presupuesto?')
    expect(facbal.createInvoice).not.toHaveBeenCalled()
  })
})

describe('regresiones en vivo — bugs críticos (sin medida / modelo / precios por posición)', () => {
  beforeEach(() => {
    sent.texts = []
    sent.buttons = []
    ai.callOpenRouter.mockReset()
    ai.callOpenRouter.mockResolvedValue({
      text: JSON.stringify({ meanings: [{ term: 'moldura', type: 'grosor', value: 4 }] }),
    })
    facbal.nextInvoiceNumber.mockResolvedValue('F-1001')
    facbal.getClientAddresses.mockResolvedValue([])
  })

  function pitem(over: Partial<PedidoItem> = {}): PedidoItem {
    return {
      cantidad: 1,
      categoria: 'BASTIDOR',
      medida: '40x89',
      variante: 'Sin Tela',
      precio_unitario: 18000,
      faltante: false,
      descripcion: 'BASTIDOR 40 x 89 Sin Tela',
      regla_aplicada: null,
      ...over,
    }
  }

  it('Bug 2 — "sin medida" conserva los demás ítems del pedido (no pierde 7 de 8)', async () => {
    const db = makeDb()
    const bastidores = ['40x60', '50x60', '60x60', '60x70', '60x80', '60x90', '60x100', '60x120'].map(
      (m) => ({ cantidad: 1, texto: `bastidor ${m} sin tela` }),
    )
    const parseFn = vi.fn(async (text: string) =>
      text.includes('sin medida')
        ? { cliente: null, items: [{ cantidad: 1, texto: 'Bastidor de Muestra con Fibro', libre: true }] }
        : { cliente: null, items: [...bastidores, { cantidad: 1, texto: 'Bastidor de Muestra con Fibro' }] },
    )

    await processPedidoMessage(args(db, 'esos 8 bastidores y un Bastidor de Muestra con Fibro', { parseFn }))
    expect(sent.texts.at(-1)).toContain('¿Qué medida para')
    expect((db as ReturnType<typeof makeDb>).getOrderContext()).toMatchObject({
      awaitingItemAttr: { ask: 'medida' },
    })

    await processPedidoMessage(args(db, 'sin medida', { parseFn }))

    const ctx = (db as ReturnType<typeof makeDb>).getOrderContext() as {
      items: { descripcion: string; medida: string | null }[]
      awaitingItemAttr?: unknown
    }
    expect(ctx.awaitingItemAttr ?? null).toBeNull()
    // Los 8 bastidores + la muestra: nada se pierde.
    expect(ctx.items).toHaveLength(9)
    expect(ctx.items.filter((it) => it.medida != null)).toHaveLength(8)
    expect(ctx.items.some((it) => /muestra/i.test(it.descripcion))).toBe(true)
  })

  it('Bug 3 — NO pisa el precio de un ítem distinto solo por posición', () => {
    const prev = [pitem({ medida: '40x89', precio_unitario: 20000, precioManual: true })]
    const next = [
      pitem({ medida: '120x240', variante: 'Con Lienzo', precio_unitario: 234000, descripcion: 'BASTIDOR 120 x 240 Con Lienzo' }),
    ]
    const merged = mergePreservedItems(next, prev)
    expect(merged[0].precio_unitario).toBe(234000)
    expect(merged[0].precioManual).toBeUndefined()
  })

  it('Bug 3 — conserva el precio manual cuando ES el mismo ítem', () => {
    const prev = [pitem({ medida: '40x89', precio_unitario: 20000, precioManual: true })]
    const next = [pitem({ medida: '40x89', precio_unitario: 18000 })]
    const merged = mergePreservedItems(next, prev)
    expect(merged[0].precio_unitario).toBe(20000)
    expect(merged[0].precioManual).toBe(true)
  })
})
