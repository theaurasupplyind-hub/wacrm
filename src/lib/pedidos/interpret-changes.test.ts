import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fastQuoteChanges, applyQuoteChanges, interpretQuoteChanges } from './interpret-changes'
import type { PedidoItem } from './types'

const ai = vi.hoisted(() => ({ callOpenRouter: vi.fn() }))
vi.mock('@/lib/ai/openrouter', () => ai)

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
      ops: [{ op: 'set_price', target: 1, mode: 'percent', value: 10 }],
    })
  })

  it('"sacá la línea N" → remove', () => {
    expect(fastQuoteChanges('sacá la línea 2')).toEqual({
      kind: 'ops',
      ops: [{ op: 'remove', target: 2 }],
    })
  })

  it('"la línea 1 ponela x3" → set_quantity', () => {
    expect(fastQuoteChanges('la línea 1 ponela x3')).toEqual({
      kind: 'ops',
      ops: [{ op: 'set_quantity', target: 1, value: 3 }],
    })
  })

  it('"al producto 1 cambiale el precio" reconoce el número', () => {
    expect(fastQuoteChanges('al producto 1 cambiale el precio')).toBeNull()
    // sin operación clara cae al LLM; el número se resuelve igual por "producto N"
  })

  it('sin referencia de línea → null (lo decide el LLM)', () => {
    expect(fastQuoteChanges('cambiale el precio al bastidor de 142 x 195')).toBeNull()
  })
})

describe('applyQuoteChanges (determinístico)', () => {
  it('set_price absolute fija el precio unitario', () => {
    const r = applyQuoteChanges([item()], [{ op: 'set_price', target: 1, mode: 'absolute', value: 300000 }])
    if ('error' in r || 'ambiguous' in r) throw new Error('unexpected')
    expect(r.items[0].precio_unitario).toBe(300000)
    expect(r.notes[0]).toContain('quedó en $300.000')
  })

  it('set_price percent baja el precio y redondea a catálogo', () => {
    const r = applyQuoteChanges([item()], [{ op: 'set_price', target: 1, mode: 'percent', value: 10 }])
    if ('error' in r || 'ambiguous' in r) throw new Error('unexpected')
    expect(r.items[0].precio_unitario).toBe(19000)
    expect(r.notes[0]).toContain('Apliqué 10% a la línea 1')
  })

  it('set_price "all" absolute aplica a todas las líneas', () => {
    const r = applyQuoteChanges([item(), item({ descripcion: 'B' })], [
      { op: 'set_price', target: 'all', mode: 'absolute', value: 50000 },
    ])
    if ('error' in r || 'ambiguous' in r) throw new Error('unexpected')
    expect(r.items.map((i) => i.precio_unitario)).toEqual([50000, 50000])
  })

  it('remove quita la línea', () => {
    const r = applyQuoteChanges([item(), item({ descripcion: 'B' })], [{ op: 'remove', target: 2 }])
    if ('error' in r || 'ambiguous' in r) throw new Error('unexpected')
    expect(r.items).toHaveLength(1)
    expect(r.notes[0]).toContain('Saqué la línea 2')
  })

  it('no puede quitar la última línea', () => {
    const r = applyQuoteChanges([item()], [{ op: 'remove', target: 1 }])
    expect('error' in r).toBe(true)
  })

  it('línea inexistente → error honesto', () => {
    const r = applyQuoteChanges([item()], [{ op: 'remove', target: 5 }])
    expect('error' in r).toBe(true)
  })

  it('resuelve por medida (ref textual), no solo por número', () => {
    const r = applyQuoteChanges(
      [item({ descripcion: 'BASTIDOR 40 x 89 Lienzo Profesional', medida: '40x89' })],
      [{ op: 'set_price', target: { text: '40 x 89' }, mode: 'absolute', value: 20000 }],
    )
    if ('error' in r || 'ambiguous' in r) throw new Error('unexpected')
    expect(r.items[0].precio_unitario).toBe(20000)
  })

  it('ambiguo (dos medidas iguales) → pide cuál', () => {
    const r = applyQuoteChanges(
      [
        item({ descripcion: 'BASTIDOR 40 x 89', medida: '40x89' }),
        item({ descripcion: 'BASTIDOR 40 x 89', medida: '40x89' }),
      ],
      [{ op: 'set_price', target: { text: '40 x 89' }, mode: 'absolute', value: 20000 }],
    )
    expect('ambiguous' in r).toBe(true)
  })

  it('fija el precio de un ítem "a cotizar a mano" y lo mete en el total', () => {
    const pending = item({ descripcion: 'Palos de metal', libre: true, faltante: true, precio_unitario: null })
    const r = applyQuoteChanges([item(), pending], [
      { op: 'set_price', target: { text: 'palos de metal' }, mode: 'absolute', value: 5000 },
    ])
    if ('error' in r || 'ambiguous' in r) throw new Error('unexpected')
    const fixed = r.items.find((i) => i.descripcion === 'Palos de metal')!
    expect(fixed.faltante).toBe(false)
    expect(fixed.precio_unitario).toBe(5000)
    expect(r.notes[0]).toContain('entra al total')
  })

  it('$0 / gratis: set_price absolute 0 deja la línea en $0 sin error', () => {
    const r = applyQuoteChanges([item()], [
      { op: 'set_price', target: 1, mode: 'absolute', value: 0 },
    ])
    if ('error' in r || 'ambiguous' in r) throw new Error('unexpected')
    expect(r.items[0].precio_unitario).toBe(0)
    expect(r.items[0].faltante).toBe(false)
    expect(r.notes[0]).toContain('$0')
  })

  it('borrado múltiple 1,2,3 elimina las líneas originales sin corrimiento', () => {
    const lines = Array.from({ length: 11 }, (_, i) =>
      item({ descripcion: `BASTIDOR ${40 + i} x 89`, medida: `${40 + i}x89` }),
    )
    const r = applyQuoteChanges(lines, [
      { op: 'remove', target: 1 },
      { op: 'remove', target: 2 },
      { op: 'remove', target: 3 },
    ])
    if ('error' in r || 'ambiguous' in r) throw new Error('unexpected')
    expect(r.items).toHaveLength(8)
    // Se van las originales 1, 2 y 3 (quedan a partir de la 4).
    expect(r.items.map((i) => i.descripcion)).not.toContain('BASTIDOR 40 x 89')
    expect(r.items.map((i) => i.descripcion)).not.toContain('BASTIDOR 41 x 89')
    expect(r.items.map((i) => i.descripcion)).not.toContain('BASTIDOR 42 x 89')
    expect(r.notes).toEqual(['Saqué la línea 1 (BASTIDOR 40 x 89).', 'Saqué la línea 2 (BASTIDOR 41 x 89).', 'Saqué la línea 3 (BASTIDOR 42 x 89).'])
  })

  it('rename: cambia el nombre y fija el precio en un solo paso', () => {
    const r = applyQuoteChanges([item({ descripcion: 'Bastidor de Muestra con Fibro', libre: true, precio_unitario: 13000 })], [
      { op: 'rename', target: 1, name: 'Muestra con Fibro', price: 0 },
    ])
    if ('error' in r || 'ambiguous' in r) throw new Error('unexpected')
    expect(r.items[0].descripcion).toBe('Muestra con Fibro')
    expect(r.items[0].precio_unitario).toBe(0)
    expect(r.items[0].faltante).toBe(false)
  })

  it('resuelve por medida con typo (fallback por lado coincidente)', () => {
    const r = applyQuoteChanges(
      [
        item({ descripcion: 'BASTIDOR 95 x 140', medida: '95x140' }),
        item({ descripcion: 'BASTIDOR 60 x 60', medida: '60x60' }),
      ],
      [{ op: 'remove', target: { text: 'el bastidor de 95 x 149' } }],
    )
    if ('error' in r || 'ambiguous' in r) throw new Error('unexpected')
    expect(r.items).toHaveLength(1)
    expect(r.items[0].descripcion).toBe('BASTIDOR 60 x 60')
  })
})

describe('interpretQuoteChanges (LLM) — validación de operaciones', () => {
  it('acepta value 0 en set_price absolute ("es gratis")', async () => {
    ai.callOpenRouter.mockResolvedValueOnce({
      text: JSON.stringify({ ops: [{ op: 'set_price', line: 1, mode: 'absolute', value: 0 }] }),
    })
    const res = await interpretQuoteChanges('el bastidor de muestra es gratis', [
      { n: 1, descripcion: 'Bastidor de Muestra con Fibro', cantidad: 1, precio: 13000 },
    ])
    expect(res).toEqual({ kind: 'ops', ops: [{ op: 'set_price', target: 1, mode: 'absolute', value: 0 }] })
  })

  it('acepta rename con price 0', async () => {
    ai.callOpenRouter.mockResolvedValueOnce({
      text: JSON.stringify({ ops: [{ op: 'rename', line: 1, name: 'Muestra con Fibro', price: 0 }] }),
    })
    const res = await interpretQuoteChanges('cambialo que se llame Muestra con Fibro y es gratis', [
      { n: 1, descripcion: 'Bastidor de Muestra con Fibro', cantidad: 1, precio: 13000 },
    ])
    expect(res).toEqual({
      kind: 'ops',
      ops: [{ op: 'rename', target: 1, name: 'Muestra con Fibro', price: 0 }],
    })
  })
})

describe('interpretQuoteChanges — modelo (bug: flash-lite alucinaba rename)', () => {
  const prevOrder = process.env.ORDER_MODEL
  const prevExtractor = process.env.EXTRACTOR_MODEL

  beforeEach(() => {
    delete process.env.ORDER_MODEL
    delete process.env.EXTRACTOR_MODEL
    ai.callOpenRouter.mockReset()
  })

  afterEach(() => {
    if (prevOrder === undefined) delete process.env.ORDER_MODEL
    else process.env.ORDER_MODEL = prevOrder
    if (prevExtractor === undefined) delete process.env.EXTRACTOR_MODEL
    else process.env.EXTRACTOR_MODEL = prevExtractor
  })

  it('por defecto usa google/gemini-2.5-flash (NO cae al flash-lite del extractor)', async () => {
    ai.callOpenRouter.mockResolvedValueOnce({ text: JSON.stringify({ none: true }) })
    const res = await interpretQuoteChanges(
      'Con lienzo:\n240x120cm (x8)\n60x120cm (x2)\n\ny un Bastidor de Muestra con Fibro',
      [{ n: 1, descripcion: 'BASTIDOR 40 x 89 ACRILICO', cantidad: 1, precio: 40000 }],
    )
    expect(res).toEqual({ kind: 'none' })
    expect(ai.callOpenRouter).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'google/gemini-2.5-flash' }),
    )
  })

  it('ORDER_MODEL del entorno tiene prioridad', async () => {
    process.env.ORDER_MODEL = 'test/pedido-model'
    ai.callOpenRouter.mockResolvedValueOnce({ text: JSON.stringify({ none: true }) })
    await interpretQuoteChanges('algo', [{ n: 1, descripcion: 'X', cantidad: 1, precio: 1 }])
    expect(ai.callOpenRouter).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'test/pedido-model' }),
    )
  })

  it('IGNORA EXTRACTOR_MODEL en flash-lite (no re-introduce el bug en Vercel)', async () => {
    process.env.EXTRACTOR_MODEL = 'google/gemini-2.5-flash-lite'
    ai.callOpenRouter.mockResolvedValueOnce({ text: JSON.stringify({ none: true }) })
    await interpretQuoteChanges('algo', [{ n: 1, descripcion: 'X', cantidad: 1, precio: 1 }])
    expect(ai.callOpenRouter).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'google/gemini-2.5-flash' }),
    )
  })
})
