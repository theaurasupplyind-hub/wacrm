import { describe, it, expect } from 'vitest'
import { resolveClarifyExtraction, type ClarifyContextState } from './clarify-context'
import type { UnifiedExtraction } from './types'

type OrigExtra = NonNullable<ClarifyContextState['origExtra']>

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
    destino: null,
    metodo_pago: null,
    fecha: null,
    faltan_campos: [],
    dudoso: false,
    razon_duda: null,
    raw: 'test',
    ...overrides,
  } as UnifiedExtraction
}

const orig: OrigExtra = {
  proveedor: 'Test',
  monto: 65000,
  metodo_pago: 'efectivo',
  destino: null,
  empleado: null,
  hora: null,
  categoria: null,
  fecha: null,
}

describe('resolveClarifyExtraction', () => {
  it('sin extracción de la respuesta (tap de botón), usa origExtra', () => {
    const r = resolveClarifyExtraction(null, orig, 'voucher', 'Me pagó (cobro)')
    expect(r.intent).toBe('voucher')
    expect(r.proveedor).toBe('Test')
    expect(r.monto).toBe(65000)
    expect(r.metodo_pago).toBe('efectivo')
    expect(r.confianza).toBe('alta')
    expect(r.faltan_campos).toEqual([])
    expect(r.dudoso).toBe(false)
    expect(r.raw).toBe('Me pagó (cobro)')
  })

  it('origExtra gana sobre la extracción (ruido) de la respuesta', () => {
    const current = extraction({
      intent: 'otro',
      confianza: 'baja',
      dudoso: true,
      proveedor: 'ruido',
      monto: 1,
    })
    const r = resolveClarifyExtraction(current, orig, 'voucher', 'x')
    expect(r.intent).toBe('voucher')
    expect(r.proveedor).toBe('Test')
    expect(r.monto).toBe(65000)
    expect(r.dudoso).toBe(false)
  })

  it('sin origExtra ni current, devuelve base con el intent elegido', () => {
    const r = resolveClarifyExtraction(null, null, 'gasto', 'Pagué yo (gasto)')
    expect(r.intent).toBe('gasto')
    expect(r.proveedor).toBeNull()
    expect(r.monto).toBeNull()
    expect(r.raw).toBe('Pagué yo (gasto)')
  })
})
