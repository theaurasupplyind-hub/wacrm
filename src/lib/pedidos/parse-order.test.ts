import { describe, it, expect } from 'vitest'
import { fallbackParseOrder } from './parse-order'

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
