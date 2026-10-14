import { describe, it, expect } from 'vitest'
import { evaluateGate, deriveMatchInfo, MATCH_MARGIN_MIN, type GateInput } from './effect-gate'
import type { UnifiedExtraction } from '@/lib/bot-llm/types'
import type { ExpenseFuzzyMatch } from '@/lib/expenses/types'

function ext(over: Partial<UnifiedExtraction> = {}): UnifiedExtraction {
  return {
    intent: 'gasto',
    confianza: 'alta',
    extractor_source: 'llm',
    empleado: null,
    hora: null,
    estado: null,
    monto: 18000,
    categoria: 'Luz',
    tipo_gasto: 'gasto',
    saldo_pendiente: null,
    proveedor: 'Edesur',
    empleado_gasto: null,
    destino: null,
    metodo_pago: null,
    fecha: null,
    faltan_campos: [],
    dudoso: false,
    razon_duda: null,
    raw: 'pagué 18 mil de luz',
    ...over,
  }
}

function input(over: Partial<GateInput> = {}): GateInput {
  return { text: 'pagué 18 mil de luz', extraction: ext(), operation: 'gasto', ...over }
}

describe('effect gate (definicion-ambiguedad.md)', () => {
  it('auto-save cuando todo está verde', () => {
    const d = evaluateGate(input())
    expect(d.decision).toBe('auto')
    expect(d.reasons).toEqual([])
  })

  it('S2: banda de pago pelada siempre confirma', () => {
    const d = evaluateGate(input({ text: 'Mati Pago', operation: 'gasto' }))
    expect(d.decision).toBe('confirma')
    expect(d.reasons).toContain('S2')
  })

  it('S1: confianza baja confirma en operación con efecto', () => {
    const d = evaluateGate(input({ extraction: ext({ confianza: 'baja' }) }))
    expect(d.decision).toBe('confirma')
    expect(d.reasons).toContain('S1')
  })

  it('S1 no bloquea lecturas ni chitchat', () => {
    const d = evaluateGate(input({ operation: 'lectura', extraction: ext({ confianza: 'baja' }) }))
    expect(d.decision).toBe('auto')
  })

  it('S3: margen de match bajo confirma', () => {
    const d = evaluateGate(input({ match: { margin: MATCH_MARGIN_MIN - 0.05 } }))
    expect(d.decision).toBe('confirma')
    expect(d.reasons).toContain('S3')
  })

  it('S4: entidad nueva confirma', () => {
    const d = evaluateGate(input({ match: { isNewEntity: true } }))
    expect(d.decision).toBe('confirma')
    expect(d.reasons).toContain('S4')
  })

  it('S5: campo faltante confirma con pregunta puntual', () => {
    const d = evaluateGate(input({ extraction: ext({ monto: null, faltan_campos: ['monto'] }) }))
    expect(d.decision).toBe('confirma')
    expect(d.reasons).toContain('S5')
    expect(d.questions).toContain('¿Cuál es el monto?')
  })

  it('S6: irreversible sin confianza alta confirma (vara estricta)', () => {
    const d = evaluateGate(
      input({ operation: 'pago', extraction: ext({ confianza: 'media', intent: 'voucher' }) }),
    )
    expect(d.decision).toBe('confirma')
    expect(d.reasons).toContain('S6')
  })

  it('S6: irreversible con confianza alta va directo', () => {
    const d = evaluateGate(
      input({ operation: 'pedido', extraction: ext({ intent: 'pedido' }), text: 'cuánto sale un bastidor 100x120' }),
    )
    expect(d.decision).toBe('auto')
  })

  it('sin extracción no bloquea (el caller decide el fallback)', () => {
    const d = evaluateGate(input({ extraction: null }))
    expect(d.decision).toBe('auto')
  })
})

describe('deriveMatchInfo (Fase 4: pre-match único)', () => {
  function match(over: Partial<ExpenseFuzzyMatch> = {}): ExpenseFuzzyMatch {
    return {
      categoryId: 1,
      categoryName: 'Luz',
      categoryWasCreated: false,
      providerId: 5,
      providerName: 'Edesur',
      employeeId: null,
      employeeName: null,
      ...over,
    }
  }

  it('margen amplio → sin S3', () => {
    const info = deriveMatchInfo(
      match({ entityScores: { provider: [{ name: 'Edesur', score: 0.95 }], employee: [] } }),
    )
    expect(info.margin).toBeGreaterThanOrEqual(MATCH_MARGIN_MIN)
    expect(info.isNewEntity).toBe(false)
  })

  it('empate dentro de la lista → margen chico', () => {
    const info = deriveMatchInfo(
      match({
        providerId: null,
        providerName: null,
        entityScores: {
          provider: [
            { name: 'Aldo Chiappe', score: 0.7 },
            { name: 'Aldo García', score: 0.65 },
          ],
          employee: [],
        },
      }),
    )
    expect(info.margin).toBeLessThan(MATCH_MARGIN_MIN)
  })

  it('empate cruzado proveedor/empleado → margen chico', () => {
    const info = deriveMatchInfo(
      match({
        entityScores: {
          provider: [{ name: 'Jorge', score: 0.8 }],
          employee: [{ name: 'Jorge', score: 0.78 }],
        },
      }),
    )
    expect(info.margin).toBeLessThan(MATCH_MARGIN_MIN)
  })

  it('nombre sin id o categoría creada → entidad nueva', () => {
    expect(deriveMatchInfo(match({ providerId: null, providerName: 'Nuevo' })).isNewEntity).toBe(true)
    expect(deriveMatchInfo(match({ categoryWasCreated: true })).isNewEntity).toBe(true)
  })

  it('sin candidatos → margen null', () => {
    expect(deriveMatchInfo(match()).margin).toBeNull()
  })
})
