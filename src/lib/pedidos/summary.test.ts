import { describe, it, expect } from 'vitest'
import { classifyOrderReply, buildOrderSummary } from './summary'
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
    for (const t of ['no', 'cancelar', 'dejalo', 'anular', 'no, nada', 'no gracias']) {
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
