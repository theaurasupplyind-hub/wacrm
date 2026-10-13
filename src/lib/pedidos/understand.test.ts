import { describe, it, expect } from 'vitest'
import { comprehendOrder, resolveClientGuess } from './understand'
import type { OrderGlossaryEntry } from './glossary'
import { preciosReferencia, pricingRules } from '../precios/__fixtures__/catalogo'

const base = { refs: preciosReferencia, rules: pricingRules }

describe('comprehendOrder', () => {
  it('marca como bloqueante un término desconocido que deja el ítem sin precio', () => {
    const r = comprehendOrder({ ...base, items: [{ cantidad: 1, texto: 'pantalla para embastar' }] })
    expect(r.blockingTerms).toEqual(['pantalla'])
    expect(r.resolved.items[0].faltante).toBe(true)
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
