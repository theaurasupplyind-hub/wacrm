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

describe('decideDispatch strong-intent escape (Fix 1)', () => {
  it('asistencia_llegada alta con gasto pendiente → attendance (no pending_multiturn)', () => {
    const r = decideDispatch({
      hasPendingExpense: true,
      hasPendingAttendance: false,
      hasPendingVoucher: false,
      hasPendingVoice: false,
      flowConsumed: false,
      interactiveReplyId: null,
      inboundText: 'Eze llego a las 9.15',
      extraction: extraction({ intent: 'asistencia_llegada', confianza: 'alta', empleado: 'Eze', hora: '09:15' }),
      mediaConsumedByVoucher: false,
    })
    expect(r.dispatchedTo).toBe('attendance')
    expect(r.dispatchReason).toBe('intent')
  })

  it('asistencia_salida sin empleado con gasto pendiente → attendance (pregunta quién)', () => {
    const r = decideDispatch({
      hasPendingExpense: true,
      hasPendingAttendance: false,
      hasPendingVoucher: false,
      hasPendingVoice: false,
      flowConsumed: false,
      interactiveReplyId: null,
      inboundText: 'Se fue a las 17.18',
      extraction: extraction({ intent: 'asistencia_salida', confianza: 'alta', hora: '17:18', faltan_campos: ['empleado'] }),
      mediaConsumedByVoucher: false,
    })
    expect(r.dispatchedTo).toBe('attendance')
  })

  it('gasto alta con asistencia pendiente → expense', () => {
    const r = decideDispatch({
      hasPendingExpense: false,
      hasPendingAttendance: true,
      hasPendingVoucher: false,
      hasPendingVoice: false,
      flowConsumed: false,
      interactiveReplyId: null,
      inboundText: 'pagué 5000 de luz',
      extraction: extraction({ intent: 'gasto', confianza: 'alta', monto: 5000 }),
      mediaConsumedByVoucher: false,
    })
    expect(r.dispatchedTo).toBe('expense')
  })

  it('otro con confianza baja y gasto pendiente → expense pending_multiturn (sigue capturando respuestas cortas)', () => {
    const r = decideDispatch({
      hasPendingExpense: true,
      hasPendingAttendance: false,
      hasPendingVoucher: false,
      hasPendingVoice: false,
      flowConsumed: false,
      interactiveReplyId: null,
      inboundText: '5000',
      extraction: extraction({ intent: 'otro', confianza: 'baja' }),
      mediaConsumedByVoucher: false,
    })
    expect(r.dispatchedTo).toBe('expense')
    expect(r.dispatchReason).toBe('pending_multiturn')
  })
})

describe('decideDispatch jevPending (System One)', () => {
  it('voucher pendiente + Jev answersPending alto → voucher (resuelve respuesta corta)', () => {
    const r = decideDispatch({
      hasPendingExpense: false,
      hasPendingAttendance: false,
      hasPendingVoucher: true,
      hasPendingVoice: false,
      flowConsumed: false,
      interactiveReplyId: null,
      inboundText: 'la 2',
      extraction: extraction({ intent: 'otro', confianza: 'baja' }),
      mediaConsumedByVoucher: false,
      jevPending: { domain: 'voucher', answersPending: 0.9, supersedes: 0.05 },
    })
    expect(r.dispatchedTo).toBe('voucher')
    expect(r.dispatchReason).toBe('pending_multiturn')
  })

  it('Jev domain "none" no roba el mensaje aunque answersPending sea alto', () => {
    const r = decideDispatch({
      hasPendingExpense: false,
      hasPendingAttendance: false,
      hasPendingVoucher: true,
      hasPendingVoice: false,
      flowConsumed: false,
      interactiveReplyId: null,
      inboundText: 'cuánto debo',
      extraction: extraction({ intent: 'factura', confianza: 'alta' }),
      mediaConsumedByVoucher: false,
      jevPending: { domain: 'none', answersPending: 0.9, supersedes: 0.1 },
    })
    expect(r.dispatchedTo).toBe('assistant')
  })

  it('Jev supersedes alto libera el pendiente y deja pasar un "otro" al assistant', () => {
    const r = decideDispatch({
      hasPendingExpense: true,
      hasPendingAttendance: false,
      hasPendingVoucher: false,
      hasPendingVoice: false,
      flowConsumed: false,
      interactiveReplyId: null,
      inboundText: 'gracias, después sigo',
      extraction: extraction({ intent: 'otro', confianza: 'alta' }),
      mediaConsumedByVoucher: false,
      jevPending: { domain: 'expense', answersPending: 0.2, supersedes: 0.9 },
    })
    expect(r.dispatchedTo).toBe('assistant')
  })

  it('Jev con answersPending bajo cae a las reglas actuales', () => {
    const r = decideDispatch({
      hasPendingExpense: true,
      hasPendingAttendance: false,
      hasPendingVoucher: false,
      hasPendingVoice: false,
      flowConsumed: false,
      interactiveReplyId: null,
      inboundText: '5000',
      extraction: extraction({ intent: 'otro', confianza: 'baja' }),
      mediaConsumedByVoucher: false,
      jevPending: { domain: 'expense', answersPending: 0.3, supersedes: 0.1 },
    })
    expect(r.dispatchedTo).toBe('expense')
    expect(r.dispatchReason).toBe('pending_multiturn')
  })
})
