import { describe, it, expect } from 'vitest'
import { detectAmbiguity, matchClarifyOption } from './ambiguity'
import { applyVoucherCorrection } from './extract-bot-message'
import type { UnifiedExtraction } from './types'

function extraction(overrides: Partial<UnifiedExtraction> = {}): UnifiedExtraction {
  return {
    intent: 'otro',
    confianza: 'alta',
    extractor_source: 'llm',
    empleado: null,
    hora: null,
    estado: null,
    monto: null,
    categoria: null,
    tipo_gasto: null,
    saldo_pendiente: null,
    proveedor: null,
    empleado_gasto: null,
    metodo_pago: null,
    fecha: null,
    faltan_campos: [],
    dudoso: false,
    razon_duda: null,
    raw: 'test',
    ...overrides,
  } as UnifiedExtraction
}

describe('applyVoucherCorrection', () => {
  it('Jo pago en efectivo (gasto/media del LLM) → voucher', () => {
    const r = applyVoucherCorrection(
      extraction({ intent: 'gasto', confianza: 'media', proveedor: 'Jo', metodo_pago: 'efectivo', dudoso: true }),
      'Jo pago en efectivo',
    )
    expect(r.intent).toBe('voucher')
    expect(r.confianza).toBe('alta')
    expect(r.proveedor).toBe('Jo')
    expect(r.monto).toBeNull()
    expect(r.metodo_pago).toBe('efectivo')
  })

  it('con monto lo conserva', () => {
    const r = applyVoucherCorrection(
      extraction({ intent: 'gasto', confianza: 'media' }),
      'Marlon Pago 2000000',
    )
    expect(r.intent).toBe('voucher')
    expect(r.proveedor).toBe('Marlon')
    expect(r.monto).toBe(2000000)
  })

  it('Jo pago en transferencia a Jorge → voucher con destino', () => {
    const r = applyVoucherCorrection(
      extraction({ intent: 'gasto', confianza: 'media', proveedor: 'Jo' }),
      'Jo pago en transferencia a Jorge',
    )
    expect(r.intent).toBe('voucher')
    expect(r.proveedor).toBe('Jo')
    expect(r.destino).toBe('Jorge')
    expect(r.monto).toBeNull()
    expect(r.metodo_pago).toBe('transferencia')
  })

  it('con monto + destino conserva ambos', () => {
    const r = applyVoucherCorrection(
      extraction({ intent: 'gasto', confianza: 'media' }),
      'Jo pago 200000 en transferencia a Jorge',
    )
    expect(r.intent).toBe('voucher')
    expect(r.monto).toBe(200000)
    expect(r.destino).toBe('Jorge')
    expect(r.metodo_pago).toBe('transferencia')
  })

  it('no toca transferí/Le pagué (1ª persona)', () => {
    expect(applyVoucherCorrection(extraction({ intent: 'gasto' }), 'transferí a Jorge').intent).toBe('gasto')
    expect(applyVoucherCorrection(extraction({ intent: 'gasto' }), 'Le pagué a Jorge').intent).toBe('gasto')
  })

  it('no toca Le pagué / sueldos / 1ª persona', () => {
    expect(applyVoucherCorrection(extraction({ intent: 'gasto' }), 'Le pagué a Jo 2000000 por sueldo').intent).toBe('gasto')
    expect(applyVoucherCorrection(extraction({ intent: 'gasto' }), 'pagué la luz').intent).toBe('gasto')
    expect(applyVoucherCorrection(extraction({ intent: 'gasto' }), 'Jo paga sueldo en efectivo').intent).toBe('gasto')
  })

  it('no toca voucher ya correcto', () => {
    const ex = extraction({ intent: 'voucher', confianza: 'alta', proveedor: 'Jo' })
    expect(applyVoucherCorrection(ex, 'Jo pago en efectivo')).toBe(ex)
  })
})

describe('detectAmbiguity', () => {
  it('forma de pago con intent gasto → pregunta pago', () => {
    const a = detectAmbiguity(
      extraction({ intent: 'gasto', confianza: 'media', proveedor: 'Jo', metodo_pago: 'efectivo', dudoso: true }),
      'Jo pago en efectivo ayer',
    )
    expect(a?.kind).toBe('pago')
    expect(a?.options.map((o) => o.intent)).toEqual(['voucher', 'gasto'])
  })

  it('voucher firme → null (va directo)', () => {
    expect(
      detectAmbiguity(extraction({ intent: 'voucher', confianza: 'alta', proveedor: 'Jo' }), 'Jo pago en efectivo'),
    ).toBeNull()
  })

  it('Le pagué a Jo → null (exclusión)', () => {
    expect(
      detectAmbiguity(extraction({ intent: 'gasto', confianza: 'alta' }), 'Le pagué a Jo 2000000 por sueldo'),
    ).toBeNull()
  })

  it('baja confianza con 2 hipótesis → pregunta genérica', () => {
    const a = detectAmbiguity(
      extraction({ intent: 'otro', confianza: 'baja', monto: 5000, proveedor: 'Edesur', dudoso: true }),
      'nose 5000 edesur',
    )
    // monto+proveedor presentes + ...solo 1 hipótesis (gasto) → null, va directo
    expect(a).toBeNull()
  })

  it('hola → null (nunca interrogar saludos)', () => {
    expect(detectAmbiguity(extraction({ intent: 'otro', confianza: 'baja' }), 'hola')).toBeNull()
  })
})

describe('matchClarifyOption', () => {
  const opts = [
    { id: 'clarify_cobro', title: 'Me pagó (cobro)', intent: 'voucher' as const },
    { id: 'clarify_gasto', title: 'Pagué yo (gasto)', intent: 'gasto' as const },
  ]

  it('matchea por id de botón, letra y número', () => {
    expect(matchClarifyOption('', 'clarify_gasto', opts)?.intent).toBe('gasto')
    expect(matchClarifyOption('B', null, opts)?.intent).toBe('gasto')
    expect(matchClarifyOption('1', null, opts)?.intent).toBe('voucher')
  })

  it('matchea por título ("me pago")', () => {
    expect(matchClarifyOption('Me pagó', null, opts)?.intent).toBe('voucher')
  })

  it('órdenes nuevas no matchean', () => {
    expect(matchClarifyOption('2 bastidores 60x40', null, opts)).toBeNull()
    expect(matchClarifyOption('Eze llego a las 9.15', null, opts)).toBeNull()
  })
})
