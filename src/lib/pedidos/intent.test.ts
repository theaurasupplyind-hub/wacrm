import { describe, expect, it } from 'vitest'
import { isExplicitBudgetCreationRequest, looksLikeOrderSlotReply, mentionsOrderItems } from './intent'
import { buildVocabulary } from '@/lib/catalog/vocabulary'
import { preciosReferencia, pricingRules } from '@/lib/precios/__fixtures__/catalogo'

describe('isExplicitBudgetCreationRequest', () => {
  it.each([
    'Armame un presupuesto de 20x20',
    'Crea el presupuesto para Fede',
    'Quiero hacer un presupuesto',
    'Necesito un presupuesto',
    'Prepará presupuesto a nombre de Juan',
  ])('recognizes explicit creation: %s', (text) => {
    expect(isExplicitBudgetCreationRequest(text)).toBe(true)
  })

  it.each([
    'Quería saber si tienen bastidores de 20x20',
    'Cuánto sale un bastidor de 20x20',
    '2 bastidores de 20x20 sin tela',
    'Estabas creando un presupuesto',
    'No quiero un presupuesto',
  ])('does not treat a query/quote as permission to create: %s', (text) => {
    expect(isExplicitBudgetCreationRequest(text)).toBe(false)
  })
})

describe('looksLikeOrderSlotReply', () => {
  it.each([
    'el cliente es Federico, es envio',
    'armalo a nombre de federico',
    'es nuevo, y armalo a nombre de federico',
    'ponelo para mañana, sin descuento',
    'retira',
  ])('detecta respuesta de slot del pedido: %s', (text) => {
    expect(looksLikeOrderSlotReply(text)).toBe(true)
  })

  it.each(['hola', 'gracias', 'cuánto debo', ''])('no confunde charla/consulta: %s', (text) => {
    expect(looksLikeOrderSlotReply(text)).toBe(false)
  })
})

describe('mentionsOrderItems con vocabulario', () => {
  const vocab = buildVocabulary(preciosReferencia, pricingRules)

  it('reconoce productos y reglas del catálogo', () => {
    expect(mentionsOrderItems('quiero 3 tapacantos', vocab)).toBe(true)
    expect(mentionsOrderItems('caja fibro 78x56', vocab)).toBe(true)
    expect(mentionsOrderItems('2 bastidores 60x40', vocab)).toBe(true)
  })

  it('una charla con "sin" no cuenta como ítem (matchToken "Sin")', () => {
    expect(mentionsOrderItems('no, sin problema', vocab)).toBe(false)
    expect(mentionsOrderItems('cambiale el descuento', vocab)).toBe(false)
  })
})
