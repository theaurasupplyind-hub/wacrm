import { describe, it, expect } from 'vitest'
import { shouldCallTools, isIdentityQuestion } from './tool-policy'
import type { UnifiedExtraction } from '@/lib/bot-llm/types'

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

describe('isIdentityQuestion', () => {
  it('detecta preguntas de identidad', () => {
    expect(isIdentityQuestion('quien sos?')).toBe(true)
    expect(isIdentityQuestion('¿quién eres?')).toBe(true)
    expect(isIdentityQuestion('que sos')).toBe(true)
    expect(isIdentityQuestion('hola')).toBe(false)
  })
})

describe('shouldCallTools', () => {
  it('null → false', () => {
    expect(shouldCallTools(null, 'hola')).toBe(false)
  })

  it('identidad nunca llama tools', () => {
    expect(shouldCallTools(extraction({ intent: 'gasto' }), 'quien sos')).toBe(false)
  })

  it('intent de acción/consulta siempre llama tools', () => {
    expect(shouldCallTools(extraction({ intent: 'gasto' }), 'algo')).toBe(true)
    expect(shouldCallTools(extraction({ intent: 'multi_expense' }), 'algo')).toBe(true)
    expect(shouldCallTools(extraction({ intent: 'factura' }), 'algo')).toBe(true)
    expect(shouldCallTools(extraction({ intent: 'asistencia_llegada' }), 'algo')).toBe(true)
  })

  it('otro con campos concretos llama tools', () => {
    expect(shouldCallTools(extraction({ intent: 'otro', monto: 5000 }), 'eso')).toBe(true)
    expect(shouldCallTools(extraction({ intent: 'otro', empleado: 'Juan' }), 'eso')).toBe(true)
  })

  it('otro con pista factual llama tools', () => {
    expect(shouldCallTools(extraction({ intent: 'otro' }), 'cuánto gasté hoy')).toBe(true)
    expect(shouldCallTools(extraction({ intent: 'otro' }), 'saldo pendiente')).toBe(true)
  })

  it('otro sin pistas ni campos no llama tools (charla)', () => {
    expect(shouldCallTools(extraction({ intent: 'otro' }), 'hola, todo bien?')).toBe(false)
    expect(shouldCallTools(extraction({ intent: 'otro' }), 'gracias!')).toBe(false)
  })
})
