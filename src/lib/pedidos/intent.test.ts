import { describe, expect, it } from 'vitest'
import { isExplicitBudgetCreationRequest, looksLikeOrderSlotReply } from './intent'

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
