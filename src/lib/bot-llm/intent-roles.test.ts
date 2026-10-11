import { describe, it, expect } from 'vitest'
import { applyRoleFields } from './intent-roles'
import type { UnifiedExtraction } from './types'

function extraction(overrides: Partial<UnifiedExtraction>): UnifiedExtraction {
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

describe('applyRoleFields', () => {
  it('completa proveedor/destino desde payer/payee en un voucher', () => {
    const r = applyRoleFields(
      extraction({ intent: 'voucher', payer: 'Jo', payee: 'Jorge', proveedor: null, destino: null }),
    )
    expect(r.proveedor).toBe('Jo')
    expect(r.destino).toBe('Jorge')
  })

  it('no pisa campos ya presentes', () => {
    const r = applyRoleFields(
      extraction({ intent: 'voucher', payer: 'Jo', payee: 'Jorge', proveedor: 'Existente', destino: 'Otro' }),
    )
    expect(r.proveedor).toBe('Existente')
    expect(r.destino).toBe('Otro')
  })

  it('no crea objeto nuevo si no hay nada que completar', () => {
    const base = extraction({ intent: 'voucher', proveedor: 'Jo', destino: 'Jorge' })
    expect(applyRoleFields(base)).toBe(base)
  })

  it('no toca extracciones que no son voucher', () => {
    const base = extraction({ intent: 'gasto', payer: 'Jo' })
    expect(applyRoleFields(base)).toBe(base)
  })
})
