import { describe, it, expect } from 'vitest'
import { sanitizeClientName } from './voucher-matching'

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
