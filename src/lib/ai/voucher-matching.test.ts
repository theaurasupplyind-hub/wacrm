import { describe, it, expect } from 'vitest'
import { sanitizeClientName, pickStickyExact, captionMatchesClient, preferByCaption, isNameMatch, isStrongNameMatch, selectNameCandidates } from './voucher-matching'

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

  it('descarta nombres de archivo y variantes pegadas (Fix 3)', () => {
    expect(sanitizeClientName('Comprobante.pdf')).toBeNull()
    expect(sanitizeClientName('comprobantepdf')).toBeNull()
    expect(sanitizeClientName('IMG_1234.jpg')).toBeNull()
    expect(sanitizeClientName('captura.png')).toBeNull()
  })

  it('descarta nombres con dígitos', () => {
    expect(sanitizeClientName('Cliente 123')).toBeNull()
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

describe('isNameMatch / isStrongNameMatch / selectNameCandidates', () => {
  const cand = (over: Partial<{ invoice_id: number; cliente_nombre: string; score: number; saldo_pendiente: number }> = {}) => ({
    invoice_id: 1,
    numero_factura: 'F-1',
    cliente_nombre: 'Ale Casagrande',
    cliente_telefono: '',
    saldo_pendiente: 200000,
    total: 200000,
    fecha: '2026-10-22',
    score: 0.35,
    ...over,
  })

  it('score alto es match fuerte', () => {
    expect(isStrongNameMatch(cand({ score: 0.7 }))).toBe(true)
    expect(isNameMatch(null, cand({ score: 0.7 }))).toBe(true)
  })

  it('score bajo + coincidencia local es match débil (no fuerte)', () => {
    expect(isStrongNameMatch(cand({ score: 0.35 }))).toBe(false)
    expect(isNameMatch('Ale', cand({ score: 0.35 }))).toBe(true)
  })

  it('score bajo sin coincidencia local no es match', () => {
    expect(isNameMatch('Pepito', cand({ score: 0.35 }))).toBe(false)
    expect(isNameMatch(null, cand({ score: 0.35 }))).toBe(false)
  })

  it('selectNameCandidates filtra saldo y ordena por score', () => {
    const out = selectNameCandidates('Ale', [
      cand({ invoice_id: 1, score: 0.35 }),
      cand({ invoice_id: 2, cliente_nombre: 'Alejandra', score: 0.4 }),
      cand({ invoice_id: 3, cliente_nombre: 'Ale Sin Saldo', saldo_pendiente: 0, score: 0.9 }),
      cand({ invoice_id: 4, cliente_nombre: 'Pepito', score: 0.1 }),
    ])
    expect(out.map((c) => c.invoice_id)).toEqual([2, 1])
  })
})
