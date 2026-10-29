import { describe, it, expect } from 'vitest'
import { planTurn, reconcilePlans, type TurnState, type TurnPlan } from './engine'
import type { TurnAction } from './actions'
import type { ClarifyOption } from '@/lib/bot-llm/ambiguity'
import type { UnifiedExtraction } from '@/lib/bot-llm/types'
import type { ClarifyContextState } from '@/lib/bot-llm/clarify-context'

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

function state(overrides: Partial<TurnState> = {}): TurnState {
  return {
    botAllowed: true,
    inboundText: '',
    interactiveReplyId: null,
    flowConsumed: false,
    mediaConsumedByVoucher: false,
    messageType: 'text',
    extraction: null,
    clarify: null,
    hasPendingExpense: false,
    hasPendingAttendance: false,
    hasPendingVoucher: false,
    hasPendingOrder: false,
    orderAwaiting: false,
    voucherCandidates: [],
    captionIsForcedVoucher: false,
    ...overrides,
  }
}

function clarifyState(overrides: Partial<ClarifyContextState> = {}): ClarifyContextState {
  const options: ClarifyOption[] = [
    { id: 'clarify_cobro', title: 'Me pagó (cobro)', intent: 'voucher' },
    { id: 'clarify_gasto', title: 'Pagué yo (gasto)', intent: 'gasto' },
  ]
  return {
    question: '¿Te pagó o pagaste vos?',
    options,
    originalIntent: 'otro',
    origExtra: {
      proveedor: 'Marlon',
      monto: 65000,
      metodo_pago: null,
      destino: null,
      empleado: null,
      hora: null,
      categoria: null,
      fecha: null,
    },
    updatedAt: Date.now(),
    renotified: false,
    ...overrides,
  }
}

function kinds(actions: TurnAction[]): string[] {
  return actions.map((a) => a.kind)
}

describe('planTurn dispatch → acciones', () => {
  it('texto "otro" → assistant y una acción run_assistant', () => {
    const p = planTurn(state({ inboundText: 'hola', extraction: extraction({ intent: 'otro' }) }))
    expect(p.dispatchedTo).toBe('assistant')
    // Comportamiento actual: el texto corto también se guarda como posible
    // referencia de voucher (route.ts:1858). Se preserva en Fase 1.
    expect(kinds(p.actions)).toEqual(['run_assistant', 'store_voucher_pending_text'])
  })

  it('gasto alta → expense, exactamente una acción y sin reply_*', () => {
    const p = planTurn(
      state({ inboundText: 'pagué 5000 de luz', extraction: extraction({ intent: 'gasto', confianza: 'alta', monto: 5000 }) }),
    )
    expect(p.dispatchedTo).toBe('expense')
    expect(kinds(p.actions)).toEqual(['run_expense'])
    expect(kinds(p.actions).some((k) => k.startsWith('reply_'))).toBe(false)
  })

  it('asistencia → attendance', () => {
    const p = planTurn(
      state({ inboundText: 'Eze llegó 9:15', extraction: extraction({ intent: 'asistencia_llegada', confianza: 'alta', empleado: 'Eze', hora: '09:15' }) }),
    )
    expect(p.dispatchedTo).toBe('attendance')
    expect(kinds(p.actions)).toEqual(['run_attendance'])
  })

  it('pedido → pedido', () => {
    const p = planTurn(state({ inboundText: '2 bastidores 60x40', extraction: extraction({ intent: 'pedido', confianza: 'alta' }) }))
    expect(p.dispatchedTo).toBe('pedido')
    expect(kinds(p.actions)).toContain('run_order')
  })

  it('gasto pendiente + respuesta corta → expense pending_multiturn', () => {
    const p = planTurn(
      state({ hasPendingExpense: true, inboundText: '5000', extraction: extraction({ intent: 'otro', confianza: 'baja' }) }),
    )
    expect(p.dispatchedTo).toBe('expense')
    expect(p.dispatchReason).toBe('pending_multiturn')
  })

  it('bot no autorizado → none y sin acciones de handler', () => {
    const p = planTurn(state({ botAllowed: false, inboundText: 'pagué 5000', extraction: extraction({ intent: 'gasto' }) }))
    expect(p.dispatchedTo).toBe('none')
    expect(kinds(p.actions)).toEqual([])
  })
})

describe('planTurn clarify (ask / resolve / expired)', () => {
  it('ambiguo (forma pelada "Nombre pagó") → pregunta con botones y guarda clarify', () => {
    const p = planTurn(
      state({
        inboundText: 'Marlon pagó 65000',
        extraction: extraction({ intent: 'gasto', confianza: 'baja', monto: 65000, proveedor: 'Marlon' }),
      }),
    )
    expect(p.clarifyHandled).toBe(true)
    expect(p.dispatchedTo).toBe('clarify')
    expect(p.dispatchReason).toBe('clarify_ask')
    expect(kinds(p.actions)).toEqual(['save_clarify', 'reply_buttons'])
  })

  it('respuesta aclaración por letra B → resuelve a gasto (una sola acción de claro)', () => {
    const p = planTurn(
      state({
        inboundText: 'B',
        clarify: { state: clarifyState(), expired: false },
        extraction: extraction({ intent: 'otro', confianza: 'baja' }),
      }),
    )
    expect(p.clarifyResolved).toBe(true)
    expect(p.clarifyAnsweredIntent).toBe('gasto')
    expect(p.dispatchedTo).toBe('expense')
    expect(p.dispatchReason).toBe('clarify_resolve')
    expect(kinds(p.actions)).toContain('clear_context')
    // La extracción resuelta trae el nombre/monto originales del clarify.
    expect(p.extraction?.proveedor).toBe('Marlon')
    expect(p.extraction?.intent).toBe('gasto')
  })

  it('regresión: tap "Me pagó (cobro)" resuelve a voucher y NO cae en fallback de gasto', () => {
    const p = planTurn(
      state({
        inboundText: 'Me pagó (cobro)',
        interactiveReplyId: 'clarify_cobro',
        clarify: { state: clarifyState(), expired: false },
      }),
    )
    expect(p.clarifyAnsweredIntent).toBe('voucher')
    expect(p.dispatchedTo).toBe('voucher')
    expect(p.dispatchReason).toBe('clarify_resolve')
  })

  it('clarify expirado → limpia y avisa', () => {
    const p = planTurn(
      state({ inboundText: 'A', clarify: { state: clarifyState(), expired: true } }),
    )
    expect(p.clarifyHandled).toBe(true)
    expect(p.dispatchReason).toBe('clarify_expired')
    expect(kinds(p.actions)).toEqual(['clear_context', 'reply_text'])
  })

  it('orden fuerte nueva supersede el clarify pendiente', () => {
    const p = planTurn(
      state({
        inboundText: 'pagué 5000 de luz',
        clarify: { state: clarifyState(), expired: false },
        extraction: extraction({ intent: 'gasto', confianza: 'alta', monto: 5000 }),
      }),
    )
    expect(p.clarifyResolved).toBe(true)
    expect(p.clarifySuperseded).toBe(true)
    expect(p.dispatchReason).toBe('clarify_superseded')
    expect(p.dispatchedTo).toBe('expense')
  })
})

describe('planTurn voucher texto / fallback', () => {
  it('voucher por texto con cliente y método → run_voucher_text', () => {
    const p = planTurn(
      state({
        inboundText: 'Marlon pagó 65000 en efectivo',
        extraction: extraction({ intent: 'voucher', confianza: 'alta', proveedor: 'Marlon', monto: 65000, metodo_pago: 'efectivo' }),
      }),
    )
    expect(kinds(p.actions)).toEqual(['run_voucher_text'])
    const a = p.actions[0]
    if (a.kind === 'run_voucher_text') expect(a.clientName).toBe('Marlon')
  })

  it('imagen con caption de voucher: el caption NO se procesa como voucher-text (evita doble pago)', () => {
    const p = planTurn(
      state({
        messageType: 'image',
        mediaConsumedByVoucher: true,
        inboundText: 'te transferí $35.000 a tu cuenta Macro',
        extraction: extraction({ intent: 'voucher', confianza: 'alta', proveedor: 'Kari', monto: 35000, metodo_pago: 'transferencia' }),
      }),
    )
    expect(kinds(p.actions)).not.toContain('run_voucher_text')
    expect(kinds(p.actions)).not.toContain('run_voucher_message_text')
    expect(kinds(p.actions)).not.toContain('store_voucher_pending_text')
    // El pipeline de imagen ya se hizo cargo de la pieza: el motor no emite nada.
    expect(p.actions).toEqual([])
  })

  it('texto no clasificado → assistant (nunca queda mudo)', () => {
    const p = planTurn(state({ inboundText: 'bla bla bla', extraction: extraction({ intent: 'otro', confianza: 'baja' }) }))
    expect(p.dispatchedTo).toBe('assistant')
    expect(kinds(p.actions)).toContain('run_assistant')
  })

  it('media sin texto y sin voucher → fallback de media', () => {
    const p = planTurn(state({ messageType: 'sticker', inboundText: '', extraction: null }))
    expect(kinds(p.actions)).toEqual(['reply_text'])
  })
})

// ─── Reconciliación determinístico vs planner (Fase 4) ───

function detPlan(overrides: Partial<TurnPlan> = {}): TurnPlan {
  return {
    dispatchedTo: 'assistant',
    dispatchReason: 'intent',
    extraction: null,
    actions: [{ kind: 'run_assistant', text: 'hola', extraction: null }],
    responded: true,
    clarifyHandled: false,
    clarifyReason: 'clarify_ask',
    clarifyResolved: false,
    clarifySuperseded: false,
    clarifyAnsweredIntent: null,
    contextFlags: { expense: false, attendance: false, voucher: false, clarify: false, order: false },
    ...overrides,
  }
}

const ALL = new Set<'assistant' | 'pedido' | 'expense' | 'attendance'>(['assistant', 'pedido', 'expense', 'attendance'])
const NONE = new Set<'assistant' | 'pedido' | 'expense' | 'attendance'>()

describe('reconcilePlans', () => {
  it('planner caído → determinístico', () => {
    const r = reconcilePlans({
      deterministic: detPlan(), plannerActions: null, plannerDomains: [], plannerError: 'timeout',
      allowedDomains: ALL, hasBlockingPending: false,
    })
    expect(r.source).toBe('deterministic')
    expect(r.reason).toBe('planner_unavailable')
  })

  it('clarify pendiente → determinístico', () => {
    const r = reconcilePlans({
      deterministic: detPlan({ dispatchedTo: 'clarify', clarifyHandled: true }),
      plannerActions: [{ kind: 'run_expense', text: 'x', extraction: null }], plannerDomains: ['expense'],
      allowedDomains: ALL, hasBlockingPending: false,
    })
    expect(r.source).toBe('deterministic')
    expect(r.reason).toBe('clarify_pending')
  })

  it('voucher congelado (propuesta con voucher) → determinístico', () => {
    const r = reconcilePlans({
      deterministic: detPlan(), plannerActions: [{ kind: 'run_voucher_message_text', text: 'A' }],
      plannerDomains: ['voucher'], allowedDomains: ALL, hasBlockingPending: false,
    })
    expect(r.source).toBe('deterministic')
    expect(r.reason).toBe('voucher_frozen')
  })

  it('dominio no habilitado → determinístico', () => {
    const r = reconcilePlans({
      deterministic: detPlan(), plannerActions: [{ kind: 'run_expense', text: 'gasté 5000', extraction: null }],
      plannerDomains: ['expense'], allowedDomains: NONE, hasBlockingPending: false,
    })
    expect(r.source).toBe('deterministic')
    expect(r.reason).toBe('domain_disabled')
  })

  it('planner conduce lectura (assistant habilitado)', () => {
    const actions: TurnAction[] = [{ kind: 'run_assistant', text: 'cuánto debe Marlon', extraction: null }]
    const r = reconcilePlans({
      deterministic: detPlan(), plannerActions: actions, plannerDomains: ['assistant'],
      allowedDomains: new Set(['assistant']), hasBlockingPending: false,
    })
    expect(r.source).toBe('planner')
    expect(r.plan.dispatchedTo).toBe('assistant')
    expect(r.plan.dispatchReason).toBe('planner')
    expect(r.plan.actions).toEqual(actions)
  })

  it('planner conduce escritura sólo si las escrituras están habilitadas', () => {
    const r = reconcilePlans({
      deterministic: detPlan(), plannerActions: [{ kind: 'run_expense', text: 'gasté 5000', extraction: null }],
      plannerDomains: ['expense'], allowedDomains: new Set(['expense']), hasBlockingPending: false,
      allowsWrites: true,
    })
    expect(r.source).toBe('planner')
    expect(r.plan.dispatchedTo).toBe('expense')
  })

  it('Fase 5: escritura del planner sin habilitar → determinístico', () => {
    const r = reconcilePlans({
      deterministic: detPlan(), plannerActions: [{ kind: 'run_expense', text: 'gasté 5000', extraction: null }],
      plannerDomains: ['expense'], allowedDomains: new Set(['expense']), hasBlockingPending: false,
      allowsWrites: false,
    })
    expect(r.source).toBe('deterministic')
    expect(r.reason).toBe('writes_disabled')
  })

  it('Fase 5: el texto inventado por el modelo se reemplaza por el del usuario', () => {
    const r = reconcilePlans({
      deterministic: detPlan(),
      plannerActions: [{ kind: 'run_expense', text: 'gasté 999999 e inventé un monto', extraction: null }],
      plannerDomains: ['expense'], allowedDomains: new Set(['expense']), hasBlockingPending: false,
      allowsWrites: true, originalText: 'pagué 5000 de luz',
    })
    expect(r.source).toBe('planner')
    expect(r.plan.actions[0]).toMatchObject({ kind: 'run_expense', text: 'pagué 5000 de luz' })
  })

  it('pendiente multi-turno: el planner no secuestra otro dominio', () => {
    const r = reconcilePlans({
      deterministic: detPlan({ dispatchedTo: 'expense', dispatchReason: 'pending_multiturn' }),
      plannerActions: [{ kind: 'run_assistant', text: '5000', extraction: null }],
      plannerDomains: ['assistant'], allowedDomains: new Set(['assistant']), hasBlockingPending: true,
    })
    expect(r.source).toBe('deterministic')
    expect(r.reason).toBe('pending_protected')
  })

  it('pendiente multi-turno: el planner puede mantener el MISMO dominio', () => {
    const r = reconcilePlans({
      deterministic: detPlan({ dispatchedTo: 'expense', dispatchReason: 'pending_multiturn' }),
      plannerActions: [{ kind: 'run_expense', text: '5000', extraction: null }],
      plannerDomains: ['expense'], allowedDomains: new Set(['expense']), hasBlockingPending: true,
      allowsWrites: true,
    })
    expect(r.source).toBe('planner')
    expect(r.plan.dispatchedTo).toBe('expense')
  })
})

describe('planTurn · follow-up voucher awaiting match', () => {
  const awaiting = {
    metodoPago: 'Efectivo' as const,
    monto: null,
    fecha: null,
    destName: null,
    attemptedName: 'Martu',
    createdAt: Date.now(),
  }

  it('nombre completo → run_voucher_text con ese nombre', () => {
    const p = planTurn(
      state({
        inboundText: 'Martina',
        extraction: extraction({ intent: 'otro', confianza: 'baja' }),
        voucherAwaitingMatch: awaiting,
      }),
    )
    expect(p.dispatchReason).toBe('voucher_awaiting_match')
    expect(kinds(p.actions)).toEqual(['clear_voucher_awaiting', 'run_voucher_text'])
    const a = p.actions[1]
    if (a.kind === 'run_voucher_text') {
      expect(a.clientName).toBe('Martina')
      expect(a.monto).toBeNull()
      expect(a.metodoPago).toBe('Efectivo')
    }
  })

  it('monto puro → run_voucher_text con monto y el nombre intentado', () => {
    const p = planTurn(
      state({
        inboundText: '422000',
        extraction: extraction({ intent: 'otro', confianza: 'baja', monto: 422000 }),
        voucherAwaitingMatch: awaiting,
      }),
    )
    expect(kinds(p.actions)).toEqual(['clear_voucher_awaiting', 'run_voucher_text'])
    const a = p.actions[1]
    if (a.kind === 'run_voucher_text') {
      expect(a.clientName).toBe('Martu')
      expect(a.monto).toBe(422000)
    }
  })

  it('cancelar → limpia y responde, sin voucher', () => {
    const p = planTurn(
      state({
        inboundText: 'cancelar',
        extraction: extraction({ intent: 'otro', confianza: 'baja' }),
        voucherAwaitingMatch: awaiting,
      }),
    )
    expect(kinds(p.actions)).toEqual(['clear_voucher_awaiting', 'reply_text'])
    expect(p.dispatchedTo).toBe('voucher')
  })

  it('gasto nuevo → limpia el awaiting y va a expense', () => {
    const p = planTurn(
      state({
        inboundText: 'gasté 5000 en luz',
        extraction: extraction({ intent: 'gasto', confianza: 'alta', monto: 5000 }),
        voucherAwaitingMatch: awaiting,
      }),
    )
    expect(kinds(p.actions)).toContain('clear_voucher_awaiting')
    expect(kinds(p.actions)).toContain('run_expense')
    expect(kinds(p.actions)).not.toContain('run_voucher_text')
  })
})

describe('planTurn · voucher con monto y sin nombre', () => {
  it('"me pagaron 422000 en efectivo" → run_voucher_text con clientName vacío', () => {
    const p = planTurn(
      state({
        inboundText: 'me pagaron 422000 en efectivo',
        extraction: extraction({
          intent: 'voucher',
          confianza: 'alta',
          monto: 422000,
          metodo_pago: 'efectivo',
          proveedor: null,
        }),
      }),
    )
    expect(kinds(p.actions)).toEqual(['run_voucher_text'])
    const a = p.actions[0]
    if (a.kind === 'run_voucher_text') {
      expect(a.clientName).toBe('')
      expect(a.monto).toBe(422000)
    }
  })

  it('voucher sin nombre ni monto → pide los datos (no cae al "No te entendí")', () => {
    const p = planTurn(
      state({
        inboundText: 'me pagaron en efectivo',
        extraction: extraction({
          intent: 'voucher',
          confianza: 'alta',
          metodo_pago: 'efectivo',
          proveedor: null,
        }),
      }),
    )
    expect(kinds(p.actions)).toEqual(['reply_text'])
    const a = p.actions[0]
    if (a.kind === 'reply_text') expect(a.text).toContain('Pasame el monto')
  })
})
