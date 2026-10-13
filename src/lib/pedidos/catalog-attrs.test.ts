import { describe, it, expect } from 'vitest'
import {
  medidaInText,
  varianteInText,
  resolveCatalogAttrs,
  sameCategoria,
} from './catalog-attrs'
import { preciosReferencia } from '../precios/__fixtures__/catalogo'

describe('medidaInText', () => {
  it('matchea medidas de unidad y diámetro con límites de palabra', () => {
    expect(medidaInText('acrilico 60cc', '60cc')).toBe(true)
    expect(medidaInText('acrilico 60 cc', '60cc')).toBe(true)
    expect(medidaInText('circular 60', '60')).toBe(true)
    expect(medidaInText('circular 160', '60')).toBe(false)
    expect(medidaInText('rollo de tela 2x5', '2 x 5')).toBe(true)
    expect(medidaInText('rollo de tela', '2 x 5')).toBe(false)
  })
})

describe('varianteInText', () => {
  it('matchea variantes por palabras (singular/plural)', () => {
    expect(varianteInText('acrilico 60cc comunes', 'Comunes')).toBe(true)
    expect(varianteInText('acrilico 60cc', 'Comunes')).toBe(false)
    expect(varianteInText('acrilico gesso premium 125cc', 'Gesso Premium')).toBe(true)
  })
})

describe('resolveCatalogAttrs', () => {
  it('determina rollo de tela por su única medida', () => {
    const r = resolveCatalogAttrs('rollo de tela', 'ROLLO DE TELA', preciosReferencia)
    expect(r.matched?.precio).toBe(197000)
  })

  it('determina acrílico cuando hay medida y variante', () => {
    const r = resolveCatalogAttrs('acrilico 60cc comunes', 'ACRILICO', preciosReferencia)
    expect(r.matched?.precio).toBe(7500)
  })

  it('con solo la medida, no determina pero ofrece las variantes', () => {
    const r = resolveCatalogAttrs('acrilico 60cc', 'ACRILICO', preciosReferencia)
    expect(r.matched).toBeNull()
    expect(r.medida).toBe('60cc')
    expect(r.varianteOptions).toContain('Comunes')
    expect(r.varianteOptions).toContain('Perlado')
  })

  it('determina circulares por diámetro', () => {
    const r = resolveCatalogAttrs('circular 60', 'CIRCULARES', preciosReferencia)
    expect(r.matched?.precio).toBe(73000)
  })

  it('sameCategoria ignora mayúsculas/acentos', () => {
    expect(sameCategoria('rollo de tela', 'ROLLO DE TELA')).toBe(true)
    expect(sameCategoria('acrilico', 'ACRILICO')).toBe(true)
  })
})
