import { describe, it, expect } from 'vitest'
import {
  suggestPrice,
  refsToProductos,
  catalogBounds,
  parseQuery,
  normalizeText,
  roundDim,
  buildSuggestionDesc,
} from './engine'
import { preciosReferencia, pricingRules } from './__fixtures__/catalogo'

// Catálogo real de backend_gal (precios_referencia + pricing_rules).
const productos = refsToProductos(preciosReferencia)

function priceOf(query: string) {
  return suggestPrice(query, productos, pricingRules)
}

describe('normalizeText / parseQuery', () => {
  it('normaliza acentos, espacios y separadores de medida', () => {
    expect(normalizeText('BASTIDOR 150 x 150 Sin Tela')).toBe('bastidor 150x150 sin tela')
  })

  it('parsea una medida triple como dims + grosor', () => {
    const parsed = parseQuery('67 x 67 x 3')
    expect(parsed.dims).toEqual(['67x67'])
    expect(parsed.grosor).toBe(3)
    expect(parsed.base).toBe('')
  })

  it('parsea base y medida simple', () => {
    const parsed = parseQuery('bastidor sin tela 42x141')
    expect(parsed.dims).toEqual(['42x141'])
    expect(parsed.base).toBe('bastidor sin tela')
    expect(parsed.grosor).toBeNull()
  })
})

describe('roundDim (snap al múltiplo de 10)', () => {
  it('baja 0-3 y sube 4-9', () => {
    expect(roundDim(81)).toBe(80)
    expect(roundDim(94)).toBe(100)
    expect(roundDim(42)).toBe(40)
    expect(roundDim(141)).toBe(140)
  })
})

describe('catalogBounds (límites derivados del catálogo, sin hardcodear)', () => {
  it('calcula los máximos reales', () => {
    const b = catalogBounds(preciosReferencia)
    expect(b).not.toBeNull()
    // Catálogo real: medida máxima 200x300 (lado mayor 300, menor 200).
    expect(b!.maxLadoMayor).toBe(300)
    expect(b!.maxLadoMenor).toBe(200)
    expect(b!.maxPerimetro).toBe(1000)
    expect(b!.maxPrecio).toBe(506000)
  })

  it('devuelve null sin refs con medidas', () => {
    expect(catalogBounds([])).toBeNull()
    expect(catalogBounds([{ categoria: 'X', medida: '60cc', variante: '', precio: 100 }])).toBeNull()
  })
})

describe('suggestPrice', () => {
  it('snap 42x141 → perímetro 360, precio de referencia (Sin Tela)', () => {
    const res = priceOf('bastidor sin tela 42x141')
    const rule = res.find(s => s.description === 'Sin Tela')
    expect(rule?.price).toBe(43000)
    expect(res.every(s => s.price !== 0 || s.estimated)).toBe(true)
  })

  it('pintura 94x81 → base Sin Tela 80x100 + regla +10%', () => {
    const res = priceOf('embastame una pintura 94x81')
    // Comportamiento literal de galv2: la regla "Tapiz" (trigger "ta") también
    // matchea por el "ta" pegado dentro de "embastame". La primera es Pinturas.
    expect(res[0].description).toBe('Pinturas')
    expect(res[0].price).toBe(47000)
    expect(res.find(s => s.description === 'Pinturas')?.price).toBe(47000)
  })

  it('acrilico 94x81 NO aplica la regla pintura', () => {
    const res = priceOf('acrilico 94x81')
    expect(res).toHaveLength(1)
    expect(res[0].suggested).toBe(false)
    expect(res[0].price).toBe(0)
    expect(res[0].hint).toContain('Sin referencia')
  })

  it('tapacanto 60x40 → precio de Lienzo Profesional 40x60', () => {
    const res = priceOf('tapacanto 60x40')
    expect(res[0].description).toBe('Tapacanto')
    expect(res[0].price).toBe(24000)
  })

  it('bastidor 60x40 → varias variantes (no asume)', () => {
    const res = priceOf('bastidor 60x40')
    const suggested = res.filter(s => s.suggested)
    expect(suggested.length).toBeGreaterThanOrEqual(4)
    const prices = suggested.map(s => s.price)
    expect(prices).toContain(18000) // Sin Tela
    expect(prices).toContain(24000) // Lienzo Profesional
    expect(prices).toContain(27000) // Lona Preparada
    expect(prices).toContain(28000) // Doble 4cm
  })

  it('medida por encima del máximo (derivado del catálogo) se resuelve a la más grande', () => {
    const b = catalogBounds(preciosReferencia)!
    const q = `${b.maxLadoMayor + 100}x${b.maxLadoMenor + 100}`
    const res = priceOf(q)
    expect(res.length).toBeGreaterThan(0)
    expect(res.some(s => s.suggested && s.price > 0)).toBe(true)
    expect(res.some(s => (s.basedOn || '').includes('200 x 300'))).toBe(true)
  })

  it('sin medidas devuelve []', () => {
    expect(priceOf('tapacanto')).toEqual([])
  })
})

describe('buildSuggestionDesc', () => {
  const pinturas = pricingRules.find(r => r.name === 'Pinturas')!
  it('arma el nombre final de la sugerencia', () => {
    expect(buildSuggestionDesc('pintura 94x81', 'Pinturas', pinturas)).toBe('Pintura 94x81')
  })

  it('descarta el prefijo de ruido cuando no hay palabras de catálogo (regresión "Sin Tela A x B")', () => {
    const sinTela = pricingRules.find(r => r.name === 'Sin Tela')!
    const knownWords = ['bastidor', 'lienzo', 'tela', 'sin', 'pintura', 'tapacanto', 'marco', 'tapiz']
    // Texto que arrastra el encabezado del usuario ("Sin lienzo (con los esquineros atrás)").
    const desc = buildSuggestionDesc('200x140cm sin con los esquineros atrás', 'Sin Tela', sinTela, knownWords)
    expect(desc).not.toContain('esquineros')
    expect(desc).not.toContain('Cm')
    expect(desc).toContain('200x140')
    expect(desc).toContain('Sin Tela')
  })

  it('conserva el prefijo solo si el resto es una palabra del catálogo', () => {
    const tapacanto = pricingRules.find(r => r.name === 'Tapacanto')!
    const base = ['bastidor', 'lienzo', 'tela', 'marco', 'tapacanto']
    // "dorado" NO está en el catálogo → se descarta el prefijo.
    expect(buildSuggestionDesc('marco dorado 45x32 tapacanto', 'Tapacanto', tapacanto, base)).toBe('Tapacanto 45x32')
    // "dorado" SÍ está en el catálogo → se conserva.
    expect(buildSuggestionDesc('marco dorado 45x32 tapacanto', 'Tapacanto', tapacanto, [...base, 'dorado'])).toBe(
      'Dorado 45x32 Tapacanto',
    )
  })
})
