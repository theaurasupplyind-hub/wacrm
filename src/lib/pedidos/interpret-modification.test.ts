import { describe, it, expect, vi, beforeEach } from 'vitest'
import { callOpenRouter } from '@/lib/ai/openrouter'
import {
  fastQuoteModification,
  interpretQuoteModification,
  applyQuoteModification,
  roundCatalogPrice,
} from './interpret-modification'
import type { PedidoItem } from './types'

vi.mock('@/lib/ai/openrouter', () => ({
  callOpenRouter: vi.fn(),
}))

const mockedCall = vi.mocked(callOpenRouter)

const LINES = [
  { n: 1, descripcion: 'Pintura 150x190', cantidad: 1, precio: 144000 },
  { n: 2, descripcion: 'Pintura 90x100', cantidad: 1, precio: 52000 },
  { n: 3, descripcion: 'Pintura 135x190', cantidad: 1, precio: 139000 },
  { n: 4, descripcion: 'Pintura 150x190', cantidad: 1, precio: 144000 },
]

function item(descripcion: string, precio: number, cantidad = 1): PedidoItem {
  return {
    cantidad,
    categoria: 'PINTURA',
    medida: null,
    variante: null,
    precio_unitario: precio,
    faltante: false,
    descripcion,
    regla_aplicada: null,
  }
}

describe('fastQuoteModification (sin LLM)', () => {
  it('línea explícita + % → discount', () => {
    expect(fastQuoteModification('a la línea 3 descuentale 10%')).toEqual({ line: 3, op: 'discount_percent', value: 10 })
    expect(fastQuoteModification('haceme 15% en el item 2')).toEqual({ line: 2, op: 'discount_percent', value: 15 })
  })

  it('sacar línea explícita → remove', () => {
    expect(fastQuoteModification('sacá la línea 2')).toEqual({ line: 2, op: 'remove', value: 0 })
    expect(fastQuoteModification('quita el item 4')).toEqual({ line: 4, op: 'remove', value: 0 })
  })

  it('cantidad explícita → set_quantity', () => {
    expect(fastQuoteModification('la línea 1 ponela x3')).toEqual({ line: 1, op: 'set_quantity', value: 3 })
  })

  it('sin referencia explícita → null (lo resuelve el LLM)', () => {
    expect(fastQuoteModification('a la pintura 135x190 descuentale 10%')).toBeNull()
    expect(fastQuoteModification('son pinturas')).toBeNull()
    expect(fastQuoteModification('sí, crealo')).toBeNull()
  })
})

describe('interpretQuoteModification (LLM)', () => {
  beforeEach(() => {
    mockedCall.mockClear()
  })

  function mockPayload(payload: unknown) {
    mockedCall.mockResolvedValueOnce({
      text: typeof payload === 'string' ? payload : JSON.stringify(payload),
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    })
  }

  it('mapea nombre de producto a número de línea', async () => {
    mockPayload({ line: 3, op: 'discount_percent', value: 10 })
    const r = await interpretQuoteModification('a la pintura 135 x 190 al precio descuentale 10%', LINES)
    expect(r).toEqual({ line: 3, op: 'discount_percent', value: 10 })
  })

  it('null del modelo → null (sigue re-cotizando)', async () => {
    mockPayload('null')
    const r = await interpretQuoteModification('son pinturas', LINES)
    expect(r).toBeNull()
  })

  it('línea fuera de rango → null', async () => {
    mockPayload({ line: 9, op: 'discount_percent', value: 10 })
    const r = await interpretQuoteModification('descuentale 10% a la línea 9', LINES)
    expect(r).toBeNull()
  })

  it('fallo del LLM → null', async () => {
    mockedCall.mockRejectedValueOnce(new Error('boom'))
    const r = await interpretQuoteModification('a la pintura descuentale 10%', LINES)
    expect(r).toBeNull()
  })
})

describe('applyQuoteModification (aritmética determinística)', () => {
  it('descuento % con redondeo de catálogo: 139000 -10% → 125000', () => {
    expect(roundCatalogPrice(139000 * 0.9)).toBe(125000)
    const items = [item('Pintura 150x190', 144000), item('Pintura 135x190', 139000)]
    const r = applyQuoteModification(items, { line: 2, op: 'discount_percent', value: 10 })
    expect('error' in r).toBe(false)
    if ('items' in r) {
      expect(r.items[1].precio_unitario).toBe(125000)
      expect(r.items[0].precio_unitario).toBe(144000)
      expect(r.note).toContain('139.000')
      expect(r.note).toContain('125.000')
    }
  })

  it('remove saca la línea pero no deja la cotización vacía', () => {
    const items = [item('A', 10000), item('B', 20000)]
    const r = applyQuoteModification(items, { line: 1, op: 'remove', value: 0 })
    expect('items' in r && r.items).toHaveLength(1)
    const solo = applyQuoteModification([item('A', 10000)], { line: 1, op: 'remove', value: 0 })
    expect('error' in solo).toBe(true)
  })

  it('set_quantity cambia cantidad', () => {
    const items = [item('A', 10000)]
    const r = applyQuoteModification(items, { line: 1, op: 'set_quantity', value: 3 })
    expect('items' in r && r.items[0].cantidad).toBe(3)
  })

  it('línea inexistente o sin precio → error honesto', () => {
    const items = [item('A', 10000)]
    expect('error' in applyQuoteModification(items, { line: 5, op: 'remove', value: 0 })).toBe(true)
    const sinPrecio = [{ ...item('B', 0), precio_unitario: null }]
    const r = applyQuoteModification(sinPrecio, { line: 1, op: 'discount_percent', value: 10 })
    expect('error' in r && (r as { error: string }).error).toContain('sin precio')
  })

  it('línea a revisar no se toca', () => {
    const items = [{ ...item('A', 10000), aRevisar: true }]
    const r = applyQuoteModification(items, { line: 1, op: 'discount_percent', value: 10 })
    expect('error' in r && (r as { error: string }).error).toContain('revisar')
  })
})
