import { describe, it, expect } from 'vitest'
import { fastQuoteChanges, applyQuoteChanges } from './interpret-changes'
import type { PedidoItem } from './types'

function item(over: Partial<PedidoItem> = {}): PedidoItem {
  return {
    cantidad: 1,
    categoria: 'BASTIDOR',
    medida: '60x60',
    variante: 'Sin Tela',
    precio_unitario: 21000,
    faltante: false,
    descripcion: 'BASTIDOR 60 x 60 Sin Tela',
    regla_aplicada: null,
    ...over,
  }
}

describe('fastQuoteChanges (sin LLM)', () => {
  it('"% en la línea N" → set_price percent (bajar precio)', () => {
    expect(fastQuoteChanges('a la línea 1 hacele 10%')).toEqual({
      kind: 'ops',
      ops: [{ op: 'set_price', line: 1, mode: 'percent', value: 10 }],
    })
  })

  it('"sacá la línea N" → remove', () => {
    expect(fastQuoteChanges('sacá la línea 2')).toEqual({
      kind: 'ops',
      ops: [{ op: 'remove', line: 2 }],
    })
  })

  it('"la línea 1 ponela x3" → set_quantity', () => {
    expect(fastQuoteChanges('la línea 1 ponela x3')).toEqual({
      kind: 'ops',
      ops: [{ op: 'set_quantity', line: 1, value: 3 }],
    })
  })

  it('sin referencia de línea → null (lo decide el LLM)', () => {
    expect(fastQuoteChanges('cambiale el precio al bastidor de 142 x 195')).toBeNull()
  })
})

describe('applyQuoteChanges (determinístico)', () => {
  it('set_price absolute fija el precio unitario', () => {
    const r = applyQuoteChanges([item()], [{ op: 'set_price', line: 1, mode: 'absolute', value: 300000 }])
    if ('error' in r) throw new Error(r.error)
    expect(r.items[0].precio_unitario).toBe(300000)
    expect(r.notes[0]).toContain('quedó en $300.000')
  })

  it('set_price percent baja el precio y redondea a catálogo', () => {
    const r = applyQuoteChanges([item()], [{ op: 'set_price', line: 1, mode: 'percent', value: 10 }])
    if ('error' in r) throw new Error(r.error)
    expect(r.items[0].precio_unitario).toBe(19000)
    expect(r.notes[0]).toContain('Apliqué 10% a la línea 1')
  })

  it('set_price "all" absolute aplica a todas las líneas', () => {
    const r = applyQuoteChanges([item(), item({ descripcion: 'B' })], [
      { op: 'set_price', line: 'all', mode: 'absolute', value: 50000 },
    ])
    if ('error' in r) throw new Error(r.error)
    expect(r.items.map((i) => i.precio_unitario)).toEqual([50000, 50000])
  })

  it('remove quita la línea', () => {
    const r = applyQuoteChanges([item(), item({ descripcion: 'B' })], [{ op: 'remove', line: 2 }])
    if ('error' in r) throw new Error(r.error)
    expect(r.items).toHaveLength(1)
    expect(r.notes[0]).toContain('Saqué la línea 2')
  })

  it('no puede quitar la última línea', () => {
    const r = applyQuoteChanges([item()], [{ op: 'remove', line: 1 }])
    expect('error' in r).toBe(true)
  })

  it('línea inexistente → error honesto', () => {
    const r = applyQuoteChanges([item()], [{ op: 'remove', line: 5 }])
    expect('error' in r).toBe(true)
  })

  it('una línea sin precio (faltante) se saltea', () => {
    const r = applyQuoteChanges(
      [item(), item({ descripcion: 'sin cotizar', precio_unitario: null, faltante: true })],
      [{ op: 'remove', line: 5 }],
    )
    expect('error' in r).toBe(true)
  })
})
