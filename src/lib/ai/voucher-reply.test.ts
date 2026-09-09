import { describe, it, expect } from 'vitest'
import { isVoucherClarificationReply, isCancelReply } from './voucher-pipeline'
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
