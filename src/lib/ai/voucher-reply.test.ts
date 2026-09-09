import { describe, it, expect } from 'vitest'
import { isVoucherClarificationReply, isCancelReply, isBareYes, hasRealMedia } from './voucher-pipeline'
import type { MatchVoucherCandidate } from '../facbal/client'

function cand(overrides: Partial<MatchVoucherCandidate> = {}): MatchVoucherCandidate {
  return {
    invoice_id: 1,
    numero_factura: 'A-0001',
    cliente_nombre: 'Jo Pérez',
    cliente_telefono: '',
    saldo_pendiente: 168000,
    total: 168000,
    fecha: '2026-09-07',
    score: 0.9,
    ...overrides,
  } as MatchVoucherCandidate
}

const two = [cand(), cand({ invoice_id: 2, numero_factura: 'A-0002', cliente_nombre: 'Marlon' })]
const one = [cand()]

describe('isVoucherClarificationReply (Fix 5)', () => {
  it('acepta letra exacta', () => {
    expect(isVoucherClarificationReply('B', two)).toBe(true)
    expect(isVoucherClarificationReply('a', two)).toBe(true)
  })

  it('acepta variantes con artículo/opción/de', () => {
    expect(isVoucherClarificationReply('la B', two)).toBe(true)
    expect(isVoucherClarificationReply('opción B', two)).toBe(true)
    expect(isVoucherClarificationReply('B de Marlon', two)).toBe(true)
  })

  it('acepta números 1-based', () => {
    expect(isVoucherClarificationReply('2', two)).toBe(true)
    expect(isVoucherClarificationReply('opción 2', two)).toBe(true)
  })

  it('acepta selección múltiple y "ambas"', () => {
    expect(isVoucherClarificationReply('A y B', two)).toBe(true)
    expect(isVoucherClarificationReply('A,B', two)).toBe(true)
    expect(isVoucherClarificationReply('ambas', two)).toBe(true)
    expect(isVoucherClarificationReply('las dos', two)).toBe(true)
    expect(isVoucherClarificationReply('las 2', two)).toBe(true)
  })

  it('"sí" confirma con 1 candidato y vale como respuesta multi', () => {
    expect(isVoucherClarificationReply('sí', one)).toBe(true)
    expect(isVoucherClarificationReply('si', two)).toBe(true)
  })

  it('acepta nombre parcial del candidato', () => {
    expect(isVoucherClarificationReply('Marlon', two)).toBe(true)
  })

  it('rechaza órdenes nuevas y candidatos vacíos', () => {
    expect(isVoucherClarificationReply('2 bastidores 60x40', two)).toBe(false)
    expect(isVoucherClarificationReply('Eze llego a las 9.15', two)).toBe(false)
    expect(isVoucherClarificationReply('B', [])).toBe(false)
  })
})

describe('isCancelReply (confirmación transferencia)', () => {
  it('anula con no/cancelar/mejor no', () => {
    expect(isCancelReply('no')).toBe(true)
    expect(isCancelReply('cancelar')).toBe(true)
    expect(isCancelReply('mejor no')).toBe(true)
  })

  it('no anula respuestas válidas', () => {
    expect(isCancelReply('sí')).toBe(false)
    expect(isCancelReply('B')).toBe(false)
    expect(isCancelReply('Jo Pérez')).toBe(false)
  })
})

describe('isBareYes (sí pelado vs todas/ambas)', () => {
  it('"sí/ok" pelado → pregunta cuál (no paga todo)', () => {
    expect(isBareYes('sí')).toBe(true)
    expect(isBareYes('si')).toBe(true)
    expect(isBareYes('ok')).toBe(true)
  })

  it('"todas/ambas" no son sí pelado (pagan todo)', () => {
    expect(isBareYes('todas')).toBe(false)
    expect(isBareYes('ambas')).toBe(false)
    expect(isBareYes('las dos')).toBe(false)
    expect(isBareYes('A y B')).toBe(false)
  })
})

describe('hasRealMedia (texto sin review)', () => {
  it('texto nunca tiene media real', () => {
    expect(hasRealMedia({ mediaMimeType: 'text/efectivo', mediaBase64: '' })).toBe(false)
    expect(hasRealMedia({ mediaMimeType: 'text/transferencia', mediaBase64: '' })).toBe(false)
  })

  it('imagen con base64 sí', () => {
    expect(hasRealMedia({ mediaMimeType: 'image/jpeg', mediaBase64: 'abc' })).toBe(true)
    expect(hasRealMedia({ mediaMimeType: 'image/jpeg', mediaBase64: '' })).toBe(false)
  })
})
