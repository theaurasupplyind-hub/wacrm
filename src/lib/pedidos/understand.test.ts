import { describe, it, expect } from 'vitest'
import { comprehendOrder, resolveClientGuess } from './understand'
import type { OrderGlossaryEntry } from './glossary'
import { preciosReferencia, pricingRules } from '../precios/__fixtures__/catalogo'

const base = { refs: preciosReferencia, rules: pricingRules }

describe('comprehendOrder', () => {
  it('marca como bloqueante un producto sin reconocer (sin medida)', () => {
    const r = comprehendOrder({ ...base, items: [{ cantidad: 1, texto: 'florero' }] })
    expect(r.blockingTerms).toEqual(['florero'])
    expect(r.resolved.items[0].faltante).toBe(true)
  })

  it('si el producto se reconoce pero falta la medida, no bloquea y pide medida', () => {
    const r = comprehendOrder({ ...base, items: [{ cantidad: 4, texto: 'pintura para embastar' }] })
    expect(r.blockingTerms).toEqual([])
    expect(r.missing).toEqual([{ itemIndex: 0, term: 'pintura para embastar', ask: 'medida', options: [] }])
  })

  it('para una categoría por atributo (acrílico) ofrece las medidas del catálogo', () => {
    const r = comprehendOrder({ ...base, items: [{ cantidad: 1, texto: 'acrilico' }] })
    expect(r.blockingTerms).toEqual([])
    expect(r.missing).toHaveLength(1)
    expect(r.missing[0].ask).toBe('medida')
    expect(r.missing[0].options).toContain('60cc')
    expect(r.missing[0].options).toContain('250cc')
  })

  it('resuelve rollo de tela por su única medida del catálogo', () => {
    const r = comprehendOrder({ ...base, items: [{ cantidad: 1, texto: 'rollo de tela' }] })
    expect(r.resolved.items[0].faltante).toBe(false)
    expect(r.resolved.items[0].precio_unitario).toBe(197000)
    expect(r.missing).toEqual([])
  })

  it('no bloquea por términos cosméticos en un ítem que igual se cotiza', () => {
    const r = comprehendOrder({ ...base, items: [{ cantidad: 1, texto: 'bastidor 60x40 rosa dior' }] })
    expect(r.blockingTerms).toEqual([])
    expect(r.resolved.items[0].faltante).toBe(false)
  })

  it('aplica el glosario antes de resolver (moldura = grosor 4)', () => {
    const glossary: OrderGlossaryEntry[] = [
      { termNorm: 'moldura', termDisplay: 'moldura', meaning: { type: 'grosor', value: 4 } },
    ]
    const r = comprehendOrder({
      ...base,
      items: [{ cantidad: 1, texto: 'moldura de 4 56x41 sin tela' }],
      glossary,
    })
    expect(r.blockingTerms).toEqual([])
    expect(r.items[0].texto).not.toContain('moldura')
    expect(r.resolved.items[0].precio_unitario).toBe(20000)
  })

  it('sin glosario, "moldura" igual resuelve (tiene medida) y no bloquea', () => {
    const r = comprehendOrder({ ...base, items: [{ cantidad: 1, texto: 'moldura de 4 56x41 sin tela' }] })
    expect(r.blockingTerms).toEqual([])
    expect(r.resolved.items[0].faltante).toBe(false)
  })
})

describe('resolveClientGuess', () => {
  const sender = '5491125491605'

  it('usa el cliente explícito', () => {
    expect(resolveClientGuess('Jorge', 'Hola Jorge, hacelo para Jorge', null, sender)).toEqual({
      value: 'Jorge',
      source: 'explicit',
      suspicious: false,
    })
  })

  it('descarta el nombre del saludo', () => {
    expect(resolveClientGuess('Jorge', 'Hola Jorge tengo 4 pinturas', null, sender)).toEqual({
      value: null,
      source: null,
      suspicious: true,
    })
  })

  it('cae al cliente del contexto cuando el parseo trae un saludo', () => {
    expect(resolveClientGuess('Jorge', 'Hola Jorge tengo 4 pinturas', 'Fede', sender)).toEqual({
      value: 'Fede',
      source: 'context',
      suspicious: true,
    })
  })

  it('nunca acepta el teléfono del remitente', () => {
    const g = resolveClientGuess(sender, `presupuesto ${sender}`, null, sender)
    expect(g.value).toBeNull()
    expect(g.suspicious).toBe(true)
  })

  it('sin cliente inferido usa el del contexto', () => {
    expect(resolveClientGuess(null, '2 bastidores 60x40', 'Fede', sender)).toEqual({
      value: 'Fede',
      source: 'context',
      suspicious: false,
    })
    expect(resolveClientGuess(null, '2 bastidores 60x40', null, sender)).toEqual({
      value: null,
      source: null,
      suspicious: false,
    })
  })
})
