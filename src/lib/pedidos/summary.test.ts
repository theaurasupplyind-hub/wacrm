import { describe, it, expect } from 'vitest'
import { classifyOrderReply, buildOrderSummary, classifyEntrega, parseDescuento } from './summary'
import { previewPedido } from './preview'
import { preciosReferencia, pricingRules } from '../precios/__fixtures__/catalogo'
import type { OrderContext } from './types'

describe('classifyOrderReply', () => {
  it('detecta confirmaciones (incluye frases compuestas)', () => {
    for (const t of ['sí', 'si', 'dale', 'confirmar', 'ok', 'listo', 'si confirmo', 'ok listo, confirmo', 'dale confirmá', 'confirmo el pedido', 'de acuerdo']) {
      expect(classifyOrderReply(t)).toBe('confirm')
    }
  })
  it('detecta cancelaciones', () => {
    for (const t of ['no', 'cancelar', 'dejalo', 'anular', 'no, nada', 'no gracias', 'no lo creas, era una prueba', 'no quiero un presupuesto']) {
      expect(classifyOrderReply(t)).toBe('cancel')
    }
  })
  it('el resto es corrección (aunque empiece con si/no)', () => {
    for (const t of ['el 2 sin tela', 'si, el 2 sin tela', 'no, sacá el 3']) {
      expect(classifyOrderReply(t)).toBe('other')
    }
  })
})

describe('buildOrderSummary', () => {
  it('lista ítems, total y faltantes; NO muestra los supuestos (van a la traza)', () => {
    const ctx: OrderContext = {
      stage: 'confirming',
      items: [
        { cantidad: 5, categoria: 'BASTIDOR', medida: '40 x 60', variante: 'Sin Tela', precio_unitario: 18000, faltante: false, descripcion: 'Bastidor 40 x 60 Sin Tela', regla_aplicada: null },
        { cantidad: 1, categoria: 'BASTIDOR', medida: null, variante: null, precio_unitario: null, faltante: true, descripcion: 'acrilico 94x81', regla_aplicada: null },
      ],
      clienteNombre: 'Juan',
      total: 90000,
      faltantes: ['acrilico 94x81'],
      notaSupuestos: ['"67x92 sin tela": asumí la regla "Sin Tela"; también aplicaba: Cambio de Tela'],
    }
    const text = buildOrderSummary(ctx)
    expect(text).toContain('TOTAL')
    expect(text).toMatch(/90[.,]000/)
    expect(text).toContain('acrilico 94x81')
    expect(text).toContain('Juan')
    expect(text).toContain('¿Confirmás?')
    // El "Asumí" no debe aparecer en el chat (queda en order_context / traza).
    expect(text).not.toContain('Asumí')
    expect(text).not.toContain('Cambio de Tela')
  })

  it('muestra entrega, fecha y descuento cuando están seteados', () => {
    const ctx: OrderContext = {
      stage: 'confirming',
      items: [
        { cantidad: 1, categoria: 'BASTIDOR', medida: '40 x 60', variante: 'Sin Tela', precio_unitario: 18000, faltante: false, descripcion: 'Bastidor 40 x 60 Sin Tela', regla_aplicada: null },
      ],
      clienteNombre: 'Juan',
      tipoEntrega: 'Envio',
      fechaEntrega: '{"desde":"7/11","hasta":"7/11","extras":[]}',
      descuento: { mode: 'percent', value: 10, amount: 1800 },
      total: 16200,
      faltantes: [],
      notaSupuestos: [],
    }
    const text = buildOrderSummary(ctx)
    expect(text).toContain('Entrega: Envio')
    expect(text).toContain('Fecha de entrega: 7/11')
    expect(text).toContain('Descuento: 10%')
    expect(text).toMatch(/16[.,]200/)
  })

  it('confirm:false no agrega la pregunta de confirmación y sí el prompt', () => {
    const ctx: OrderContext = {
      stage: 'confirming',
      items: [],
      clienteNombre: null,
      total: 0,
      faltantes: [],
      notaSupuestos: [],
    }
    const text = buildOrderSummary(ctx, { confirm: false, prompt: '¿A nombre de quién?' })
    expect(text).toContain('¿A nombre de quién?')
    expect(text).not.toContain('¿Confirmás?')
  })
})

describe('classifyEntrega', () => {
  it('detecta retira / envío / ambos', () => {
    expect(classifyEntrega('retira')).toBe('Retira')
    expect(classifyEntrega('lo paso a buscar')).toBe('Retira')
    expect(classifyEntrega('envío')).toBe('Envio')
    expect(classifyEntrega('te lo mando')).toBe('Envio')
    expect(classifyEntrega('las dos')).toBe('Retiro y Envio')
    expect(classifyEntrega('ret+env')).toBe('Retiro y Envio')
    expect(classifyEntrega('no sé')).toBeNull()
  })
})

describe('parseDescuento', () => {
  it('interpreta monto, porcentaje y skip', () => {
    expect(parseDescuento('no', 10000)).toBe('skip')
    expect(parseDescuento('0', 10000)).toBe('skip')
    expect(parseDescuento('10%', 10000)).toEqual({ mode: 'percent', value: 10, amount: 1000 })
    expect(parseDescuento('$1500', 10000)).toEqual({ mode: 'amount', value: 1500, amount: 1500 })
    expect(parseDescuento('2000', 10000)).toEqual({ mode: 'amount', value: 2000, amount: 2000 })
    expect(parseDescuento('mmm', 10000)).toBeNull()
  })
})

describe('previewPedido', () => {
  it('resuelve y arma el resumen sin side effects', async () => {
    const preview = await previewPedido('2 bastidores 60x40 sin tela', {
      refs: preciosReferencia,
      rules: pricingRules,
      parseFn: async () => ({ cliente: 'Juan', items: [{ cantidad: 2, texto: 'bastidor sin tela 60x40' }] }),
    })
    expect(preview).not.toBeNull()
    expect(preview!.total).toBe(36000) // 2 x 18000 (Sin Tela 40x60)
    expect(preview!.text).toContain('Bastidor')
    expect(preview!.text).toContain('Sin Tela')
    expect(preview!.text).toContain('Juan')
    expect(preview!.text).toContain('Cotización estimada:')
    expect(preview!.text).not.toContain('¿Confirmás?')
  })

  it('null si no hay ítems', async () => {
    const preview = await previewPedido('hola', {
      refs: preciosReferencia,
      rules: pricingRules,
      parseFn: async () => ({ cliente: null, items: [] }),
    })
    expect(preview).toBeNull()
  })
})
