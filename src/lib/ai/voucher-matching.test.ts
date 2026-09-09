import { describe, it, expect } from 'vitest'
import { sanitizeClientName, pickStickyExact } from './voucher-matching'

describe('sanitizeClientName (Fix 4)', () => {
  it('descarta Gracias! y palabras de comprobante', () => {
    expect(sanitizeClientName('Gracias!')).toBeNull()
    expect(sanitizeClientName('gracias')).toBeNull()
    expect(sanitizeClientName('Comprobante')).toBeNull()
    expect(sanitizeClientName('transferencia')).toBeNull()
  })

  it('descarta nombres muy cortos o vacíos', () => {
    expect(sanitizeClientName(null)).toBeNull()
    expect(sanitizeClientName('')).toBeNull()
    expect(sanitizeClientName('Jo')).toBeNull()
  })

  it('conserva nombres reales de cliente', () => {
    expect(sanitizeClientName('Jo Pérez')).toBe('Jo Pérez')
    expect(sanitizeClientName('Mathias')).toBe('Mathias')
  })
})

describe('pickStickyExact (sticky Fase 1)', () => {
  const exact = { invoice_id: 1, numero_factura: 'F-10813' }

  it('entrega el único exacto ante no_match + pool vacío', () => {
    expect(pickStickyExact([exact], 'no_match', 0)).toBe(exact)
  })

  it('no pisa con 0 o 2+ exactos', () => {
    expect(pickStickyExact([], 'no_match', 0)).toBeNull()
    expect(pickStickyExact([exact, { ...exact, invoice_id: 2 }], 'no_match', 0)).toBeNull()
  })

  it('no pisa ambiguous ni pool con entradas', () => {
    expect(pickStickyExact([exact], 'ambiguous', 0)).toBeNull()
    expect(pickStickyExact([exact], 'no_match', 1)).toBeNull()
    expect(pickStickyExact([exact], 'matched', 0)).toBeNull()
  })
})
