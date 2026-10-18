import { describe, it, expect } from 'vitest'
import {
  applyOrderGlossary,
  applyOrderGlossaryText,
  detectInlineDefinition,
  normalizeTerm,
  stripGlossaryReview,
  wantsGlossaryReview,
  type OrderGlossaryEntry,
} from './glossary'
import { buildKnownVocab, detectUnknownTerms } from './classify-item'
import { resolveItems } from './resolve-items'
import { preciosReferencia, pricingRules } from '../precios/__fixtures__/catalogo'

const vocab = buildKnownVocab(preciosReferencia, pricingRules)

describe('detectUnknownTerms', () => {
  it('marca "moldura" como desconocido', () => {
    const terms = detectUnknownTerms([{ cantidad: 1, texto: 'moldura de 4 56x41 sin tela' }], vocab)
    expect(terms.map(t => t.term)).toContain('moldura')
  })

  it('no marca nada en pedidos con vocabulario conocido', () => {
    for (const texto of ['bastidor sin tela 60x40', 'tapacanto 60x40', 'lienzo profesional 80x100', 'pintura 94x81']) {
      expect(detectUnknownTerms([{ cantidad: 1, texto }], vocab)).toEqual([])
    }
  })

  it('ignora términos ya presentes en el glosario', () => {
    const glossary: OrderGlossaryEntry[] = [{ termNorm: 'moldura', termDisplay: 'moldura', meaning: { type: 'grosor', value: 4 } }]
    expect(detectUnknownTerms([{ cantidad: 1, texto: 'moldura de 4 56x41' }], vocab, glossary)).toEqual([])
  })
})

describe('applyOrderGlossaryText', () => {
  it('grosor: convierte la medida a triple y quita el término', () => {
    const glossary: OrderGlossaryEntry[] = [{ termNorm: 'moldura', termDisplay: 'moldura', meaning: { type: 'grosor', value: 4 } }]
    const out = applyOrderGlossaryText('moldura de 4 56x41 sin tela', glossary)
    expect(out).not.toContain('moldura')
    expect(out).toContain('56x41x4')
  })

  it('alias: reemplaza el término por el texto canónico', () => {
    const glossary: OrderGlossaryEntry[] = [{ termNorm: 'moldura', termDisplay: 'moldura', meaning: { type: 'alias', value: 'doble 4cm' } }]
    const out = applyOrderGlossaryText('moldura 56x41', glossary)
    expect(out).toContain('doble 4cm')
  })

  it('grosor explícito ("con 4 de grosor") también se normaliza', () => {
    expect(applyOrderGlossaryText('56x41 con 4 de grosor sin tela', [])).toContain('56x41x4')
    expect(applyOrderGlossaryText('sin tela 60x40 4cm de grosor', [])).toContain('60x40x4')
  })
})

describe('Plan B — alias tipado y producto fuera de catálogo', () => {
  it('alias TIPADO: sustituye el término por el target canónico', () => {
    const glossary: OrderGlossaryEntry[] = [
      { termNorm: 'fantasia', termDisplay: 'fantasía', meaning: { type: 'alias', target_type: 'variante', target: 'sin tela' } },
    ]
    expect(applyOrderGlossaryText('bastidor 60x40 fantasia', glossary)).toContain('sin tela')
  })

  it('producto aprendido: NO sustituye el texto y marca el ítem libre con su precio', () => {
    const glossary: OrderGlossaryEntry[] = [
      { termNorm: 'palos', termDisplay: 'Palos de metal', meaning: { type: 'producto', value: 'Palos de metal', precio: 5000 } },
    ]
    const items = applyOrderGlossary([{ cantidad: 1, texto: 'palos de metal' }], glossary)
    expect(items[0].libre).toBe(true)
    expect(items[0].precio).toBe(5000)
    expect(items[0].texto).toContain('palos de metal')
  })

  it('producto sin precio: queda libre y a cotizar a mano', () => {
    const glossary: OrderGlossaryEntry[] = [
      { termNorm: 'soporte', termDisplay: 'soporte X', meaning: { type: 'producto', value: 'soporte X', precio: null } },
    ]
    const items = applyOrderGlossary([{ cantidad: 1, texto: 'soporte x' }], glossary)
    expect(items[0].libre).toBe(true)
    expect(items[0].precio ?? null).toBeNull()
  })

  it('producto aprendido entra a la cotización como línea manual con precio', () => {
    const glossary: OrderGlossaryEntry[] = [
      { termNorm: 'palos', termDisplay: 'Palos de metal', meaning: { type: 'producto', value: 'Palos de metal', precio: 5000 } },
    ]
    const items = applyOrderGlossary([{ cantidad: 2, texto: 'palos de metal' }], glossary)
    const r = resolveItems({ items, refs: preciosReferencia, rules: pricingRules })
    expect(r.items[0].categoria).toBe('LIBRE')
    expect(r.items[0].precio_unitario).toBe(5000)
    expect(r.items[0].faltante).toBe(false)
  })
})

describe('resolve end-to-end con glosario', () => {
  it('"moldura de 4" como grosor aplica el +10% de Sin Tela (grosor ≥ 3)', () => {
    const glossary: OrderGlossaryEntry[] = [{ termNorm: 'moldura', termDisplay: 'moldura', meaning: { type: 'grosor', value: 4 } }]
    const items = applyOrderGlossary([{ cantidad: 1, texto: 'moldura de 4 56x41 sin tela' }], glossary)
    const r = resolveItems({ items, refs: preciosReferencia, rules: pricingRules })
    // Sin Tela 40x60 = 18.000 + 10% (grosor 4 ≥ 3) = 19.800 → redondeo 1000 → 20.000
    expect(r.items[0].faltante).toBe(false)
    expect(r.items[0].precio_unitario).toBe(20000)
  })
})

describe('normalizeTerm', () => {
  it('normaliza acentos y mayúsculas', () => {
    expect(normalizeTerm('  Moldura  ')).toBe('moldura')
    expect(normalizeTerm('Acrílico')).toBe('acrilico')
  })
})

describe('detección de glosario en el mensaje', () => {
  it('detecta "revisá el glosario"', () => {
    expect(wantsGlossaryReview('revisá el glosario')).toBe(true)
    expect(wantsGlossaryReview('revisa el glosario, moldura significa grosor')).toBe(true)
    expect(wantsGlossaryReview('mira el glosario')).toBe(true)
    expect(wantsGlossaryReview('2 bastidores 60x40')).toBe(false)
  })

  it('quita la frase de revisión del mensaje', () => {
    const out = stripGlossaryReview('revisá el glosario, dame 2 de 60x40')
    expect(out).toContain('dame 2 de 60x40')
    expect(out).not.toContain('glosario')
  })

  it('detecta una definición en línea', () => {
    const d = detectInlineDefinition('moldura significa grosor')
    expect(d?.term).toBe('moldura')
    expect(d?.meaning).toBe('grosor')
  })

  it('separa la definición del pedido que la acompaña', () => {
    const d = detectInlineDefinition('tapiz significa marco con tela, dame 2 de 60x40')
    expect(d?.term).toBe('tapiz')
    expect(d?.cleaned).toContain('dame 2 de 60x40')
  })

  it('no detecta definición en un pedido común', () => {
    expect(detectInlineDefinition('2 bastidores 60x40 sin tela')).toBeNull()
    expect(detectInlineDefinition('revisá el glosario')).toBeNull()
  })
})
