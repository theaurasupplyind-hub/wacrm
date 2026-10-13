import { describe, it, expect } from 'vitest'
import { resolveItems } from './resolve-items'
import { catalogBounds } from '@/lib/precios'
import { preciosReferencia, pricingRules } from '../precios/__fixtures__/catalogo'

const base = { refs: preciosReferencia, rules: pricingRules }

describe('resolveItems', () => {
  it('regla: pintura aplica +10% sobre Sin Tela (sin el artefacto Tapiz)', () => {
    const r = resolveItems({ ...base, items: [{ cantidad: 1, texto: 'embastame una pintura 94x81' }] })
    const it = r.items[0]
    expect(it.faltante).toBe(false)
    expect(it.regla_aplicada).toBe('Pinturas')
    expect(it.precio_unitario).toBe(47000)
    expect(r.faltantes).toEqual([])
    expect(r.notaSupuestos.some(n => n.includes('Tapiz'))).toBe(false)
  })

  it('ambigüedad de variante: asume la primera sin preguntar', () => {
    const r = resolveItems({ ...base, items: [{ cantidad: 5, texto: 'bastidor 60x40' }] })
    const it = r.items[0]
    expect(it.faltante).toBe(false)
    // Orden estable del motor: `slPriority` pone primero las variantes S/L
    // (Lienzo Profesional / Lona Preparada / Sin Tela) y de esas, la primera.
    expect(it.variante).toBe('Lienzo Profesional')
    expect(it.precio_unitario).toBe(24000)
    expect(it.asumido).toContain('Lienzo Profesional')
    expect(r.notaSupuestos.some(n => n.includes('varias variantes'))).toBe(true)
    expect(r.total).toBe(120000)
  })

  it('sin referencia: ítem faltante, excluido del total', () => {
    const r = resolveItems({
      ...base,
      items: [
        { cantidad: 1, texto: 'bastidor sin tela 60x40' },
        { cantidad: 1, texto: 'acrilico 94x81' },
      ],
    })
    expect(r.items[1].faltante).toBe(true)
    expect(r.items[1].precio_unitario).toBeNull()
    expect(r.faltantes).toHaveLength(1)
    expect(r.total).toBe(18000) // sólo el cotizable
  })

  it('medida por encima del máximo: precio provisional (a revisar) derivado del catálogo', () => {
    const bounds = catalogBounds(preciosReferencia)!
    const r = resolveItems({ ...base, items: [{ cantidad: 1, texto: '400x300' }] })
    const it = r.items[0]
    expect(it.aRevisar).toBe(true)
    expect(it.precio_unitario).toBe(bounds.maxPrecio)
    expect(r.total).toBe(bounds.maxPrecio)
  })

  it('perímetro: sin exacto usa la referencia más cercana', () => {
    const r = resolveItems({ ...base, items: [{ cantidad: 1, texto: 'bastidor 42x141' }] })
    const it = r.items[0]
    expect(it.faltante).toBe(false)
    expect(it.asumido).toContain('referencia')
    expect(r.notaSupuestos.some(n => n.includes('perímetro'))).toBe(true)
  })

  it('sin medidas: faltante', () => {
    const r = resolveItems({ ...base, items: [{ cantidad: 1, texto: 'tapacanto' }] })
    expect(r.items[0].faltante).toBe(true)
  })

  it('el clasificador elige la regla correcta (sin el artefacto "Tapiz" del motor)', () => {
    const r = resolveItems({ ...base, items: [{ cantidad: 1, texto: 'tapacanto 60x40' }] })
    const it = r.items[0]
    expect(it.regla_aplicada).toBe('Tapacanto')
    expect(it.precio_unitario).toBe(24000)
    expect(r.notaSupuestos.some(n => n.includes('Tapiz'))).toBe(false)
  })

  it('unidad "cm" ya no rompe el match (clasificador → consulta canónica)', () => {
    const r = resolveItems({ ...base, items: [{ cantidad: 1, texto: 'bastidor 60x94 cm' }] })
    const it = r.items[0]
    expect(it.faltante).toBe(false)
    expect(it.categoria).toBe('BASTIDOR')
    expect(it.precio_unitario).toBeGreaterThan(0)
  })

  it('medida no estándar sin variante: snap/perímetro (no faltante)', () => {
    const r = resolveItems({ ...base, items: [{ cantidad: 1, texto: 'bastidor 25x45 cm' }] })
    expect(r.items[0].faltante).toBe(false)
  })

  it('productos por atributo: resuelve por catálogo (rollo, acrílico, circulares)', () => {
    const rollo = resolveItems({ ...base, items: [{ cantidad: 1, texto: 'rollo de tela' }] })
    expect(rollo.items[0].faltante).toBe(false)
    expect(rollo.items[0].precio_unitario).toBe(197000)

    const acr = resolveItems({ ...base, items: [{ cantidad: 1, texto: 'acrilico 60cc comunes' }] })
    expect(acr.items[0].faltante).toBe(false)
    expect(acr.items[0].categoria).toBe('ACRILICO')
    expect(acr.items[0].precio_unitario).toBe(7500)

    const circ = resolveItems({ ...base, items: [{ cantidad: 1, texto: 'circular 60' }] })
    expect(circ.items[0].faltante).toBe(false)
    expect(circ.items[0].precio_unitario).toBe(73000)
  })

  it('acrílico sin medida/variante queda faltante (no inventa)', () => {
    const r = resolveItems({ ...base, items: [{ cantidad: 1, texto: 'acrilico' }] })
    expect(r.items[0].faltante).toBe(true)
  })

  it('no contamina "rollo de tela" con la variante Sin Tela (colisión categoría/variante)', () => {
    const r = resolveItems({ ...base, items: [{ cantidad: 1, texto: 'rollo de tela 2x5 sin tela' }] })
    expect(r.items[0].faltante).toBe(false)
    expect(r.items[0].categoria).toBe('ROLLO DE TELA')
    expect(r.items[0].precio_unitario).toBe(197000)
  })

  it('corrección "sin tela" reemplaza la variante anterior en la descripción', () => {
    const r = resolveItems({ ...base, items: [{ cantidad: 1, texto: 'lienzo profesional 62.5x76.5 sin tela' }] })
    const it = r.items[0]
    expect(it.faltante).toBe(false)
    expect(it.descripcion).toContain('Sin Tela')
    expect(it.descripcion).not.toContain('Lienzo Profesional')
  })
})
