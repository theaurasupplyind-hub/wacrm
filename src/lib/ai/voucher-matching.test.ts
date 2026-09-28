import { describe, it, expect } from 'vitest'
import { sanitizeClientName, pickStickyExact, captionMatchesClient, preferByCaption } from './voucher-matching'

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

describe('captionMatchesClient (caption como preferencia)', () => {
  it('matchea parcial e ignora tildes/mayúsculas', () => {
    expect(captionMatchesClient('Jesus', 'Jesus Daniel')).toBe(true)
    expect(captionMatchesClient('jesús daniel', 'Jesus Daniel')).toBe(true)
    expect(captionMatchesClient('Perez', 'Juan Pérez')).toBe(true)
  })

  it('no matchea nombres distintos', () => {
    expect(captionMatchesClient('Jesus', 'Mathias Lopez')).toBe(false)
    expect(captionMatchesClient('', 'Jesus')).toBe(false)
  })
})

describe('preferByCaption (nunca veta: no deja el pool vacío)', () => {
  const items = [
    { cliente_nombre: 'Mathias Lopez' },
    { cliente_nombre: 'Jesus Daniel' },
  ]
  const nameOf = (i: { cliente_nombre: string }) => i.cliente_nombre

  it('prioriza los que matchean el caption', () => {
    expect(preferByCaption(items, 'Jesus', nameOf)).toEqual([{ cliente_nombre: 'Jesus Daniel' }])
  })

  it('regresión: caption sin match devuelve TODOS los items (monto exacto no se pierde)', () => {
    expect(preferByCaption(items, 'Cliente Inexistente', nameOf)).toEqual(items)
  })

  it('sin caption devuelve todos', () => {
    expect(preferByCaption(items, null, nameOf)).toEqual(items)
    expect(preferByCaption(items, '', nameOf)).toEqual(items)
    expect(preferByCaption([], 'Jesus', nameOf)).toEqual([])
  })
})
