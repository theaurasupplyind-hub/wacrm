import { describe, it, expect } from 'vitest'
import { buildKnownVocab, classifyItem } from './classify-item'
import { preciosReferencia, pricingRules } from '../precios/__fixtures__/catalogo'

const vocab = buildKnownVocab(preciosReferencia, pricingRules)

describe('classifyItem', () => {
  it('extrae medida y categoría, ignorando la unidad "cm"', () => {
    const c = classifyItem('bastidor 60x94 cm', vocab)
    expect(c.medida).toEqual({ s: 60, l: 94 })
    expect(c.categoria).toBe('BASTIDOR')
    expect(c.regla).toBeNull()
    expect(c.unknownTerms).toEqual([])
  })

  it('detecta variante Sin Tela y su regla', () => {
    const c = classifyItem('bastidor sin tela 60x40', vocab)
    expect(c.variante).toBe('Sin Tela')
    expect(c.regla?.name).toBe('Sin Tela')
  })

  it('detecta la regla Tapacanto (sin el artefacto "Tapiz")', () => {
    const c = classifyItem('tapacanto 60x40', vocab)
    expect(c.regla?.name).toBe('Tapacanto')
  })

  it('detecta Pinturas en "embastame una pintura 94x81"', () => {
    const c = classifyItem('embastame una pintura 94x81', vocab)
    expect(c.regla?.name).toBe('Pinturas')
  })

  it('detecta "Cambio de Tela" (2 palabras) por sobre "Poner tela" (1)', () => {
    const c = classifyItem('cambio de tela 60x40', vocab)
    expect(c.regla?.name).toBe('Cambio de Tela')
  })

  it('marca "moldura" como término desconocido', () => {
    const c = classifyItem('moldura de 4 56x41 sin tela', vocab)
    expect(c.unknownTerms).toContain('moldura')
    expect(c.variante).toBe('Sin Tela')
  })

  it('detecta categorías no-bastidor', () => {
    expect(classifyItem('acrilico 94x81', vocab).categoria).toBe('ACRILICO')
    expect(classifyItem('rollo 2x5', vocab).categoria).toBe('ROLLO DE TELA')
  })

  it('no aplica variantes BASTIDOR a categorías que no lo son', () => {
    const c = classifyItem('rollo de tela 2x5 sin tela', vocab)
    expect(c.categoria).toBe('ROLLO DE TELA')
    expect(c.variante).toBeNull()
  })

  it('si el texto menciona varias variantes, gana la última', () => {
    const c = classifyItem('lienzo profesional 62.5x76.5 sin tela', vocab)
    expect(c.variante).toBe('Sin Tela')
  })
})
