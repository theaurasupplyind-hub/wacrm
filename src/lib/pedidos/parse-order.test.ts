import { describe, it, expect, vi, afterEach } from 'vitest'
import { fallbackParseOrder, parseOrder } from './parse-order'

const ai = vi.hoisted(() => ({ callOpenRouter: vi.fn() }))
vi.mock('@/lib/ai/openrouter', () => ai)

describe('fallbackParseOrder', () => {
  it('una medida simple', () => {
    const r = fallbackParseOrder('bastidor sin tela 42x141')
    expect(r.items).toHaveLength(1)
    expect(r.items[0].cantidad).toBe(1)
    expect(r.items[0].texto).toContain('42x141')
  })

  it('cantidades por número y por palabra', () => {
    const r = fallbackParseOrder('5 bastidores 60x40, 3 de 60x70 y uno de 90x10')
    expect(r.items.map(i => i.cantidad)).toEqual([5, 3, 1])
    expect(r.items.map(i => i.texto.match(/\d+x\d+/)?.[0])).toEqual(['60x40', '60x70', '90x10'])
  })

  it('modificador final aplica a toda la lista', () => {
    const r = fallbackParseOrder('56 x 78, 89 x 67, 67 x 56 sin tela')
    expect(r.items).toHaveLength(3)
    expect(r.items.every(i => i.texto.includes('sin tela'))).toBe(true)
  })

  it('cliente explícito', () => {
    const r = fallbackParseOrder('hacele a Matías 2 de 60x40 sin tela')
    expect(r.cliente).toBe('Matías')
    expect(r.items[0].cantidad).toBe(2)
    expect(r.items[0].texto).toContain('sin tela')
  })

  it('sin medidas no devuelve ítems', () => {
    expect(fallbackParseOrder('hola que tal').items).toEqual([])
  })
})

describe('parseOrder — modelo y "libre" (Fase 3/4)', () => {
  const prev = process.env.ORDER_MODEL
  afterEach(() => {
    if (prev === undefined) delete process.env.ORDER_MODEL
    else process.env.ORDER_MODEL = prev
    ai.callOpenRouter.mockReset()
  })

  it('usa gemini-2.5-flash por default (no flash-lite) y propaga "libre"', async () => {
    delete process.env.ORDER_MODEL
    ai.callOpenRouter.mockResolvedValueOnce({
      text: JSON.stringify({
        cliente: null,
        items: [{ cantidad: 1, texto: 'Bastidor de Muestra con Fibro', precio: null, libre: true }],
      }),
    })
    const r = await parseOrder('y un Bastidor de Muestra con Fibro')
    expect(ai.callOpenRouter).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'google/gemini-2.5-flash' }),
    )
    expect(r.items[0].libre).toBe(true)
  })

  it('respeta ORDER_MODEL del entorno', async () => {
    process.env.ORDER_MODEL = 'test/model'
    ai.callOpenRouter.mockResolvedValueOnce({
      text: JSON.stringify({
        cliente: null,
        items: [{ cantidad: 1, texto: '60x40', precio: null, libre: false }],
      }),
    })
    await parseOrder('bastidor 60x40')
    expect(ai.callOpenRouter).toHaveBeenCalledWith(expect.objectContaining({ model: 'test/model' }))
  })
})
