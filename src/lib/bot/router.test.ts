import { describe, it, expect } from 'vitest'
import { decideDispatch } from './router'
import { looksLikeExpense } from '@/lib/expenses'
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

describe('decideDispatch routing', () => {
  it('otro sin pendings → assistant', () => {
    const r = decideDispatch({
      hasPendingExpense: false,
      hasPendingAttendance: false,
      hasPendingVoucher: false,
      flowConsumed: false,
      interactiveReplyId: null,
      inboundText: 'hola',
      extraction: extraction({ intent: 'otro', confianza: 'alta' }),
      mediaConsumedByVoucher: false,
    })
    expect(r.dispatchedTo).toBe('assistant')
    expect(r.dispatchReason).toBe('intent')
  })

  it('gasto pendiente + intent gasto → expense', () => {
    const r = decideDispatch({
      hasPendingExpense: true,
      hasPendingAttendance: false,
      hasPendingVoucher: false,
      flowConsumed: false,
      interactiveReplyId: null,
      inboundText: 'pagué 5000',
      extraction: extraction({ intent: 'gasto', confianza: 'alta' }),
      mediaConsumedByVoucher: false,
    })
    expect(r.dispatchedTo).toBe('expense')
  })

  it('texto no clasificado → assistant (nunca queda mudo)', () => {
    const r = decideDispatch({
      hasPendingExpense: false,
      hasPendingAttendance: false,
      hasPendingVoucher: false,
      flowConsumed: false,
      interactiveReplyId: null,
      inboundText: 'bla bla bla',
      extraction: extraction({ intent: 'otro', confianza: 'baja' }),
      mediaConsumedByVoucher: false,
    })
    expect(r.dispatchedTo).toBe('assistant')
  })

  it('lista de medidas sin intent → pedido (fallback regex)', () => {
    const r = decideDispatch({
      hasPendingExpense: false,
      hasPendingAttendance: false,
      hasPendingVoucher: false,
      flowConsumed: false,
      interactiveReplyId: null,
      inboundText: '2 bastidores 60x40',
      extraction: extraction({ intent: 'otro', confianza: 'baja' }),
      mediaConsumedByVoucher: false,
    })
    expect(r.dispatchedTo).toBe('pedido')
    expect(r.dispatchReason).toBe('fallback_regex')
  })
})

describe('decideDispatch pedido', () => {
  const base = {
    hasPendingExpense: false,
    hasPendingAttendance: false,
    hasPendingVoucher: false,
    flowConsumed: false,
    interactiveReplyId: null,
    mediaConsumedByVoucher: false,
  }

  it('intent pedido → pedido', () => {
    const r = decideDispatch({
      ...base,
      inboundText: '56 x 78, 89 x 67, 67 x 56 sin tela',
      extraction: extraction({ intent: 'pedido', confianza: 'alta' }),
    })
    expect(r.dispatchedTo).toBe('pedido')
    expect(r.dispatchReason).toBe('intent')
  })

  it('la mención conversacional de un presupuesto sin productos no inicia el flujo', () => {
    const r = decideDispatch({
      ...base,
      inboundText: 'Estabas creando un presupuesto',
      extraction: extraction({ intent: 'pedido', confianza: 'alta' }),
    })
    expect(r.dispatchedTo).toBe('assistant')
  })

  it('la mención conversacional tampoco activa el fallback pedido cuando intent=otro', () => {
    const r = decideDispatch({
      ...base,
      inboundText: 'Estabas creando un presupuesto',
      extraction: extraction({ intent: 'otro', confianza: 'alta' }),
    })
    expect(r.dispatchedTo).toBe('assistant')
  })

  it('una petición explícita de crear presupuesto inicia el handler aunque falten ítems', () => {
    const r = decideDispatch({
      ...base,
      inboundText: 'Armame un presupuesto',
      extraction: extraction({ intent: 'otro', confianza: 'media' }),
    })
    expect(r.dispatchedTo).toBe('pedido')
  })

  it('pedido pendiente + respuesta corta → pedido (pending_multiturn)', () => {
    const r = decideDispatch({
      ...base,
      hasPendingOrder: true,
      inboundText: 'dale',
      extraction: extraction({ intent: 'otro', confianza: 'baja' }),
    })
    expect(r.dispatchedTo).toBe('pedido')
    expect(r.dispatchReason).toBe('pending_multiturn')
  })

  it('dominio explícito (gasto alta) gana al pedido pendiente → expense', () => {
    const r = decideDispatch({
      ...base,
      hasPendingOrder: true,
      inboundText: 'pagué 5000 de luz',
      extraction: extraction({ intent: 'gasto', confianza: 'alta', monto: 5000 }),
    })
    expect(r.dispatchedTo).toBe('expense')
    expect(r.dispatchReason).toBe('intent')
  })

  it('compra a proveedor con monto NO va a pedido → gasto', () => {
    const r = decideDispatch({
      ...base,
      inboundText: 'compré 3 bastidores 60x40 a Joaquín por 30000',
      extraction: extraction({ intent: 'gasto', confianza: 'alta', monto: 30000, proveedor: 'Joaquín' }),
    })
    expect(r.dispatchedTo).toBe('expense')
  })
})

describe('decideDispatch strong-intent escape (Fix 1)', () => {
  it('asistencia_llegada alta con gasto pendiente → attendance (no pending_multiturn)', () => {
    const r = decideDispatch({
      hasPendingExpense: true,
      hasPendingAttendance: false,
      hasPendingVoucher: false,
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

describe('decideDispatch clarifyAnsweredIntent', () => {
  const base = {
    hasPendingExpense: false,
    hasPendingAttendance: false,
    hasPendingVoucher: false,
    flowConsumed: false,
    interactiveReplyId: null,
    extraction: null,
    mediaConsumedByVoucher: false,
  }

  it('documenta la trampa: el título del botón matchea looksLikeExpense', () => {
    expect(looksLikeExpense('Me pagó (cobro)')).toBe(true)
  })

  it('voucher resuelto gana al fallback regex aunque no haya extracción', () => {
    const r = decideDispatch({
      ...base,
      inboundText: 'Me pagó (cobro)',
      clarifyAnsweredIntent: 'voucher',
    })
    expect(r.dispatchedTo).toBe('voucher')
    expect(r.dispatchReason).toBe('clarify_resolve')
  })

  it('gasto resuelto → expense', () => {
    const r = decideDispatch({
      ...base,
      inboundText: 'Pagué yo (gasto)',
      clarifyAnsweredIntent: 'gasto',
    })
    expect(r.dispatchedTo).toBe('expense')
    expect(r.dispatchReason).toBe('clarify_resolve')
  })

  it('asistencia resuelta → attendance', () => {
    const r = decideDispatch({
      ...base,
      inboundText: 'Es asistencia',
      clarifyAnsweredIntent: 'asistencia_llegada',
    })
    expect(r.dispatchedTo).toBe('attendance')
    expect(r.dispatchReason).toBe('clarify_resolve')
  })

  it('factura resuelta → assistant', () => {
    const r = decideDispatch({
      ...base,
      inboundText: 'Es consulta de deuda',
      clarifyAnsweredIntent: 'factura',
    })
    expect(r.dispatchedTo).toBe('assistant')
    expect(r.dispatchReason).toBe('clarify_resolve')
  })

  it('sin señal de clarify, un tap interactivo se mantiene interactivo', () => {
    const r = decideDispatch({
      ...base,
      interactiveReplyId: 'expense_confirm',
      inboundText: 'Confirmar',
    })
    expect(r.dispatchedTo).toBe('interactive')
  })
})

describe('decideDispatch — cotización descartada reanudable (incidente 15/10)', () => {
  const base = {
    hasPendingExpense: false,
    hasPendingAttendance: false,
    hasPendingVoucher: false,
    hasResumableQuote: true,
    flowConsumed: false,
    interactiveReplyId: null,
    mediaConsumedByVoucher: false,
  }

  it('"perdón, sí, quiero que hagas presupuesto" reanuda → pedido (no assistant)', () => {
    const r = decideDispatch({
      ...base,
      inboundText: 'perdon, si quiero que llo hagas presupuesto',
      extraction: extraction({ intent: 'otro', confianza: 'alta' }),
    })
    expect(r.dispatchedTo).toBe('pedido')
    expect(r.dispatchReason).toBe('pending_multiturn')
  })

  it('una respuesta corta de confirmación reanuda → pedido', () => {
    const r = decideDispatch({
      ...base,
      inboundText: 'dale',
      extraction: extraction({ intent: 'otro', confianza: 'baja' }),
    })
    expect(r.dispatchedTo).toBe('pedido')
  })

  it('una corrección con ítems reanuda → pedido', () => {
    const r = decideDispatch({
      ...base,
      inboundText: 'cambiá el bastidor 142 x 195',
      extraction: extraction({ intent: 'otro', confianza: 'baja' }),
    })
    expect(r.dispatchedTo).toBe('pedido')
  })

  it('una respuesta de slot (cliente/entrega) reanuda → pedido', () => {
    const r = decideDispatch({
      ...base,
      inboundText: 'el cliente es Federico, es envio',
      extraction: extraction({ intent: 'otro', confianza: 'baja' }),
    })
    expect(r.dispatchedTo).toBe('pedido')
  })

  it('"armalo a nombre de X" reanuda → pedido', () => {
    const r = decideDispatch({
      ...base,
      inboundText: 'es nuevo, y armalo a nombre de federico',
      extraction: extraction({ intent: 'otro', confianza: 'baja' }),
    })
    expect(r.dispatchedTo).toBe('pedido')
  })

  it('una consulta ajena (deuda) NO la secuestra → assistant', () => {
    const r = decideDispatch({
      ...base,
      inboundText: 'cuánto debe Aldo',
      extraction: extraction({ intent: 'otro', confianza: 'alta' }),
    })
    expect(r.dispatchedTo).toBe('assistant')
  })

  it('sin cotización descartada el mismo texto va al assistant', () => {
    const r = decideDispatch({
      ...base,
      hasResumableQuote: false,
      inboundText: 'dale',
      extraction: extraction({ intent: 'otro', confianza: 'baja' }),
    })
    expect(r.dispatchedTo).toBe('assistant')
  })
})
