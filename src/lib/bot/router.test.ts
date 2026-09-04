import { describe, it, expect } from 'vitest'
import { decideDispatch } from './router'
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
    metodo_pago: null,
    fecha: null,
    faltan_campos: [],
    dudoso: false,
    razon_duda: null,
    raw: 'test',
    ...overrides,
  } as UnifiedExtraction
}

describe('decideDispatch hasPendingVoice guard', () => {
  it('otro sin pendings → assistant', () => {
    const r = decideDispatch({
      hasPendingExpense: false,
      hasPendingAttendance: false,
      hasPendingVoucher: false,
      hasPendingVoice: false,
      flowConsumed: false,
      interactiveReplyId: null,
      inboundText: 'hola',
      extraction: extraction({ intent: 'otro', confianza: 'alta' }),
      mediaConsumedByVoucher: false,
    })
    expect(r.dispatchedTo).toBe('assistant')
    expect(r.dispatchReason).toBe('intent')
  })

  it('otro con hasPendingVoice true → voice (no roba confirmación)', () => {
    const r = decideDispatch({
      hasPendingExpense: false,
      hasPendingAttendance: false,
      hasPendingVoucher: false,
      hasPendingVoice: true,
      flowConsumed: false,
      interactiveReplyId: null,
      inboundText: 'dale',
      extraction: extraction({ intent: 'otro', confianza: 'alta' }),
      mediaConsumedByVoucher: false,
    })
    expect(r.dispatchedTo).toBe('voice')
    expect(r.dispatchReason).toBe('pending_multiturn')
  })

  it('respuesta_confirmacion con pendingInvoice (via hasPendingVoice) → voice', () => {
    const r = decideDispatch({
      hasPendingExpense: false,
      hasPendingAttendance: false,
      hasPendingVoucher: false,
      hasPendingVoice: true,
      flowConsumed: false,
      interactiveReplyId: null,
      inboundText: 'si',
      extraction: extraction({ intent: 'otro', confianza: 'baja' }),
      mediaConsumedByVoucher: false,
    })
    expect(r.dispatchedTo).toBe('voice')
  })

  it('pedido alta → voice', () => {
    const r = decideDispatch({
      hasPendingExpense: false,
      hasPendingAttendance: false,
      hasPendingVoucher: false,
      hasPendingVoice: false,
      flowConsumed: false,
      interactiveReplyId: null,
      inboundText: '2 bastidores 60x40',
      extraction: extraction({ intent: 'pedido', confianza: 'alta' }),
      mediaConsumedByVoucher: false,
    })
    expect(r.dispatchedTo).toBe('voice')
  })

  it('expense con hasPendingVoice true pero intent gasto → expense (pendingExpense wins)', () => {
    const r = decideDispatch({
      hasPendingExpense: true,
      hasPendingAttendance: false,
      hasPendingVoucher: false,
      hasPendingVoice: true,
      flowConsumed: false,
      interactiveReplyId: null,
      inboundText: 'pagué 5000',
      extraction: extraction({ intent: 'gasto', confianza: 'alta' }),
      mediaConsumedByVoucher: false,
    })
    // pendingExpense is checked before hasPendingVoice guard, so expense wins
    expect(r.dispatchedTo).toBe('expense')
  })
})
