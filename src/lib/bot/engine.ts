import type { BotIntent, UnifiedExtraction } from '@/lib/bot-llm/types'
import type { ClarifyContextState } from '@/lib/bot-llm/clarify-context'
import type { MatchVoucherCandidate } from '@/lib/facbal/client'
import { decideDispatch } from '@/lib/bot/router'
import { buildJevPending } from '@/lib/bot-llm/classify-jev'
import { detectAmbiguity, matchClarifyOption } from '@/lib/bot-llm/ambiguity'
import { resolveClarifyExtraction } from '@/lib/bot-llm/clarify-context'
import { isVoucherClarificationReply } from '@/lib/ai/voucher-pipeline'
import type { TurnAction } from './actions'
import { applyPolicy, actionDomain, isWriteAction, DEFAULT_POLICY, type PlannerDomain, type PolicyContext } from './policy'

/**
 * Motor de turnos — FASE 1 (motor puro).
 *
 * `planTurn(state)` recibe ya cargado el estado del turno (contextos + la
 * extracción que hizo el adapter) y devuelve un `TurnPlan`: la decisión del
 * router, la extracción resuelta y la lista ordenada de acciones a materializar.
 *
 * Es PURA: no importa Supabase, Meta ni handlers. Reproduce 1:1 el bloque
 * `route.ts` (context-command queda en el adapter, ver plan §5 Fase 1):
 *   clarify (expired/resolve/cancel/supersede/reask/ask)
 *   → decideDispatch
 *   → acciones de handler por dominio
 *   → voucher-texto / voucher-pending
 *   → fallback "no entendí".
 */

export interface TurnState {
  botAllowed: boolean
  inboundText: string
  /** id del tap interactivo CRUDO (el motor decide internamente si es de clarify). */
  interactiveReplyId: string | null
  flowConsumed: boolean
  mediaConsumedByVoucher: boolean
  messageType: string
  extraction: UnifiedExtraction | null
  clarify: { state: ClarifyContextState; expired: boolean } | null
  hasPendingExpense: boolean
  hasPendingAttendance: boolean
  hasPendingVoucher: boolean
  hasPendingOrder: boolean
  /** Cotización descartada (soft-cancel) recordable (ver router). */
  hasResumableQuote?: boolean
  orderAwaiting: boolean
  /** Candidatas de vouchers pendientes (para no robar la respuesta con un clarify). */
  voucherCandidates: MatchVoucherCandidate[]
  /** Caption de imagen/documento que en realidad es nombre de cliente de un voucher. */
  captionIsForcedVoucher: boolean
}

export interface TurnPlan {
  dispatchedTo: string
  dispatchReason: string
  extraction: UnifiedExtraction | null
  actions: TurnAction[]
  responded: boolean
  clarifyHandled: boolean
  clarifyReason: string
  clarifyResolved: boolean
  clarifySuperseded: boolean
  clarifyAnsweredIntent: BotIntent | null
  contextFlags: {
    expense: boolean
    attendance: boolean
    voucher: boolean
    clarify: boolean
    order: boolean
  }
}

const CLARIFY_SUPERSEDING_INTENTS: BotIntent[] = [
  'gasto',
  'multi_expense',
  'voucher',
  'factura',
  'asistencia_llegada',
  'asistencia_salida',
  'asistencia_estado',
]

function isStrongNewIntent(extraction: UnifiedExtraction | null): boolean {
  if (!extraction) return false
  if (extraction.confianza !== 'alta' && extraction.confianza !== 'media') return false
  return CLARIFY_SUPERSEDING_INTENTS.includes(extraction.intent)
}

const EXPIRED_MSG =
  'Tu respuesta llegó tarde y ya había descartado la pregunta (duran 5 minutos). Mandame de nuevo tu mensaje y lo procesamos.'
const CANCEL_MSG = 'Listo, dejamos eso de lado. ¿En qué te ayudo?'
const REASK_SUFFIX = 'Respondé con la letra (A, B...) o escribí "cancelar".'
const GIVE_UP_MSG =
  'Sigo sin entenderte. Probá con algo concreto, por ejemplo: "gasté 5000 en luz", "llegó Juan 8:30" o "Marlon pagó 200000".'
const VOUCHER_NO_CLIENT_MSG =
  'No pude registrar el pago. Pasame el nombre del cliente y el monto, por ejemplo: "Marlon pagó 65000 en efectivo".'
const FALLBACK_TEXT_MSG =
  'No te entendí 🤔 ¿me repetís? Puedo registrar gastos, pagos/comprobantes o asistencias, y consultar saldos de clientes.'
const FALLBACK_MEDIA_MSG =
  'No pude leer eso 🤔 Mandame el detalle por texto (ej: "gasté 5000 en luz") o una foto del comprobante.'

export interface PlanTurnOptions {
  policy?: PolicyContext
}

export function planTurn(state: TurnState, options: PlanTurnOptions = {}): TurnPlan {
  const actions: TurnAction[] = []
  const {
    botAllowed,
    inboundText,
    interactiveReplyId,
    flowConsumed,
    mediaConsumedByVoucher,
    messageType,
    clarify: clarifyLoad,
    hasPendingExpense,
    hasPendingAttendance,
    hasPendingVoucher,
    hasPendingOrder,
    orderAwaiting,
    voucherCandidates,
  } = state

  let extraction = state.extraction
  let responded = false
  let clarifyHandled = false
  let clarifyReason = 'clarify_ask'
  let clarifyResolved = false
  let clarifySuperseded = false
  let clarifyAnsweredIntent: BotIntent | null = null

  // Los taps a botones de clarify (ids clarify_*) los resuelve el flujo clarify,
  // nunca `decideDispatch` (que si no vería 'interactive' y no resolvería nada).
  const clarifyButtonIds =
    clarifyLoad && !clarifyLoad.expired ? clarifyLoad.state.options.map((o) => o.id) : []
  const clarifyTapConsumed =
    !!interactiveReplyId &&
    (clarifyButtonIds.includes(interactiveReplyId) || interactiveReplyId.startsWith('clarify_'))

  const strongNewIntent = isStrongNewIntent(extraction)

  // ── CLARIFY (preguntar ante ambigüedad y resolver) ──
  if (botAllowed && !flowConsumed && (inboundText.trim() || interactiveReplyId)) {
    if (clarifyLoad?.expired) {
      actions.push({ kind: 'clear_context', domain: 'clarify' })
      actions.push({ kind: 'reply_text', text: EXPIRED_MSG })
      clarifyHandled = true
      clarifyReason = 'clarify_expired'
    } else if (clarifyLoad && !clarifyLoad.expired) {
      const clarifyState = clarifyLoad.state
      const chosen = matchClarifyOption(inboundText, interactiveReplyId, clarifyState.options)
      if (chosen) {
        actions.push({ kind: 'clear_context', domain: 'clarify' })
        extraction = resolveClarifyExtraction(extraction, clarifyState.origExtra, chosen.intent, inboundText)
        clarifyAnsweredIntent = chosen.intent
        clarifyResolved = true
      } else if (/^cancelar$/i.test(inboundText.trim())) {
        actions.push({ kind: 'clear_context', domain: 'clarify' })
        actions.push({ kind: 'reply_text', text: CANCEL_MSG })
        clarifyHandled = true
        clarifyReason = 'clarify_cancelled'
      } else if (strongNewIntent) {
        actions.push({ kind: 'clear_context', domain: 'clarify' })
        clarifyResolved = true
        clarifySuperseded = true
      } else if (!clarifyState.renotified) {
        actions.push({ kind: 'save_clarify', state: { ...clarifyState, renotified: true } })
        actions.push({
          kind: 'reply_buttons',
          body: `No entendí tu respuesta. ${clarifyState.question} ${REASK_SUFFIX}`,
          options: clarifyState.options,
        })
        clarifyHandled = true
        clarifyReason = 'clarify_reask'
      } else {
        actions.push({ kind: 'clear_context', domain: 'clarify' })
        actions.push({ kind: 'reply_text', text: GIVE_UP_MSG })
        clarifyHandled = true
        clarifyReason = 'clarify_cancelled'
      }
    } else if (!clarifyLoad && extraction && !interactiveReplyId) {
      const ambiguity = detectAmbiguity(extraction, inboundText)
      const voucherStealsReply =
        !!ambiguity &&
        ambiguity.kind === 'baja_confianza' &&
        hasPendingVoucher &&
        isVoucherClarificationReply(inboundText, voucherCandidates)
      if (ambiguity && !voucherStealsReply) {
        actions.push({
          kind: 'save_clarify',
          state: {
            question: ambiguity.question,
            options: ambiguity.options,
            originalIntent: extraction.intent,
            origExtra: {
              proveedor: extraction.proveedor ?? ambiguity.subject ?? null,
              monto: extraction.monto,
              metodo_pago: extraction.metodo_pago,
              destino: extraction.destino,
              empleado: extraction.empleado,
              hora: extraction.hora,
              categoria: extraction.categoria,
              fecha: extraction.fecha,
            },
          },
        })
        actions.push({ kind: 'reply_buttons', body: ambiguity.question, options: ambiguity.options, clearOnFailure: true })
        clarifyHandled = true
        clarifyReason = 'clarify_ask'
      }
    }
  }

  // ── ROUTER ──
  const routerDecision = !botAllowed
    ? { dispatchedTo: 'none' as const, dispatchReason: 'none' as const }
    : clarifyHandled
      ? {
          dispatchedTo: 'clarify' as const,
          dispatchReason: clarifyReason as 'clarify_ask' | 'clarify_reask' | 'clarify_expired' | 'clarify_cancelled',
        }
      : decideDispatch({
          hasPendingExpense,
          hasPendingAttendance,
          hasPendingVoucher,
          hasPendingOrder,
          hasResumableQuote: state.hasResumableQuote ?? false,
          orderAwaiting,
          flowConsumed,
          interactiveReplyId: clarifyTapConsumed ? null : interactiveReplyId,
          inboundText,
          extraction,
          mediaConsumedByVoucher,
          jevPending: buildJevPending(extraction),
          clarifyAnsweredIntent,
        })

  const dispatchedTo: string = routerDecision.dispatchedTo
  let dispatchReason: string = routerDecision.dispatchReason
  if (!clarifyHandled && clarifyResolved) {
    dispatchReason = clarifySuperseded ? 'clarify_superseded' : 'clarify_resolve'
  }

  // ── DISPATCH → acciones ──
  switch (dispatchedTo) {
    case 'clarify':
      responded = true
      break
    case 'expense':
      actions.push({ kind: 'run_expense', text: inboundText, extraction: extraction ?? null })
      responded = true
      break
    case 'attendance':
      actions.push({ kind: 'run_attendance', text: inboundText, extraction: extraction ?? null })
      responded = true
      break
    case 'voucher':
      // El trabajo real lo hacen las passthrough de voucher-texto/pending de abajo.
      break
    case 'pedido':
      actions.push({ kind: 'run_order', text: inboundText })
      responded = true
      break
    case 'assistant':
      if (!hasPendingVoucher) {
        if (state.captionIsForcedVoucher) {
          // La imagen la maneja el voucher (forcedCaption); el asistente calla.
          responded = true
        } else {
          actions.push({ kind: 'run_assistant', text: inboundText, extraction })
          responded = true
        }
      }
      break
    case 'flow':
    case 'interactive':
      responded = true
      break
    default:
      break
  }

  // ── VOUCHER POR TEXTO / PENDING ──
  if (botAllowed && !clarifyHandled) {
    const montoVoucherText = extraction?.monto ?? null
    const metodoVoucherText =
      extraction?.metodo_pago === 'efectivo' || (!extraction?.metodo_pago && inboundText.toLowerCase().includes('efectivo'))
        ? ('Efectivo' as const)
        : extraction?.metodo_pago === 'transferencia' || (!extraction?.metodo_pago && inboundText.toLowerCase().includes('transferencia'))
          ? ('Transferencia' as const)
          : null
    const isVoucherText =
      !hasPendingVoucher &&
      !flowConsumed &&
      (!interactiveReplyId || clarifyResolved) &&
      inboundText.trim() &&
      extraction?.intent === 'voucher' &&
      (montoVoucherText == null || montoVoucherText > 0) &&
      !!extraction.proveedor &&
      metodoVoucherText != null

    if (isVoucherText && extraction?.proveedor && metodoVoucherText) {
      actions.push({
        kind: 'run_voucher_text',
        clientName: extraction.proveedor,
        destName: extraction.destino ?? null,
        metodoPago: metodoVoucherText,
        monto: montoVoucherText,
        fecha: extraction.fecha ?? null,
      })
      responded = true
    } else if (hasPendingVoucher && !flowConsumed && inboundText.trim()) {
      const looksLikeReply = isVoucherClarificationReply(inboundText, voucherCandidates)
      const strongOrder =
        (extraction?.confianza === 'alta' || extraction?.confianza === 'media') &&
        (extraction?.intent === 'gasto' ||
          extraction?.intent === 'multi_expense' ||
          extraction?.intent === 'factura' ||
          extraction?.intent === 'asistencia_llegada' ||
          extraction?.intent === 'asistencia_salida' ||
          extraction?.intent === 'asistencia_estado')
      if (looksLikeReply || !strongOrder) {
        actions.push({ kind: 'run_voucher_message_text', text: inboundText })
        responded = true
      }
      // else: orden nueva con intent fuerte → el pending se mantiene.
    } else if (!flowConsumed && !interactiveReplyId && inboundText.trim() && !hasPendingVoucher) {
      const strongOrder =
        (extraction?.confianza === 'alta' || extraction?.confianza === 'media') &&
        (extraction?.intent === 'gasto' ||
          extraction?.intent === 'multi_expense' ||
          extraction?.intent === 'factura' ||
          extraction?.intent === 'voucher' ||
          extraction?.intent === 'asistencia_llegada' ||
          extraction?.intent === 'asistencia_salida' ||
          extraction?.intent === 'asistencia_estado')
      const couldBeVoucherRef =
        inboundText.trim().length <= 40 && !/[?¿]/.test(inboundText) && !strongOrder
      if (couldBeVoucherRef) {
        actions.push({ kind: 'store_voucher_pending_text', text: inboundText })
      }
    }
  }

  // Clarify resuelto a voucher pero sin datos para matchear: nunca quedar mudo.
  if (clarifyResolved && !responded && extraction?.intent === 'voucher') {
    actions.push({ kind: 'reply_text', text: VOUCHER_NO_CLIENT_MSG })
    responded = true
  }

  // ── FALLBACK conversacional ──
  const hasUsableText = inboundText.trim().length > 0
  if (
    botAllowed &&
    !responded &&
    !clarifyHandled &&
    !flowConsumed &&
    !interactiveReplyId &&
    hasUsableText &&
    messageType === 'text'
  ) {
    actions.push({ kind: 'reply_text', text: FALLBACK_TEXT_MSG })
  } else if (
    botAllowed &&
    !responded &&
    !clarifyHandled &&
    !flowConsumed &&
    !interactiveReplyId &&
    !hasUsableText &&
    !mediaConsumedByVoucher
  ) {
    actions.push({ kind: 'reply_text', text: FALLBACK_MEDIA_MSG })
  }

  return {
    dispatchedTo,
    dispatchReason,
    extraction,
    actions: applyPolicy(actions, options.policy ?? DEFAULT_POLICY),
    responded,
    clarifyHandled,
    clarifyReason,
    clarifyResolved,
    clarifySuperseded,
    clarifyAnsweredIntent,
    contextFlags: {
      expense: hasPendingExpense,
      attendance: hasPendingAttendance,
      voucher: hasPendingVoucher,
      clarify: !!clarifyLoad?.state,
      order: hasPendingOrder,
    },
  }
}

// ─── Reconciliación determinístico vs planner (Fase 4) ───

export interface ReconcileArgs {
  /** Plan determinístico (Fase 1). Nunca se descarta sin motivo. */
  deterministic: TurnPlan
  /** Acciones propuestas por el planner (null si no corrió / falló). */
  plannerActions: TurnAction[] | null
  plannerDomains: string[]
  plannerError?: string | null
  /** Dominios habilitados para conducir (`ASSISTANT_PLANNER_DOMAINS`). */
  allowedDomains: Set<PlannerDomain>
  /** Hay un pendiente multi-turno (gasto/asistencia/pedido) que no debe ser secuestrado. */
  hasBlockingPending: boolean
  /** Fase 5: el planner sólo puede conducir escrituras si está habilitado explícitamente. */
  allowsWrites?: boolean
  /** Texto original del usuario (invariante de escrituras). */
  originalText?: string
  /** Dedupe de escrituras dentro del turno. */
  seenWriteKeys?: Set<string>
}

export interface ReconcileResult {
  plan: TurnPlan
  source: 'deterministic' | 'planner'
  reason: string
}

/**
 * Decide si el planner conduce el turno o si gana el determinístico.
 *
 * Reglas de seguridad (Fase 4):
 *  - Planner caído/sin acciones → determinístico.
 *  - Clarify pendiente → determinístico (la pregunta ya se hizo).
 *  - Vouchers congelados: ni determinístico-voucher ni propuesta con voucher pasan por el planner.
 *  - Dominio no habilitado → determinístico.
 *  - Pendiente multi-turno + el planner quiere OTRO dominio → determinístico (no secuestra respuestas cortas).
 * En el resto, gana el planner. Las escrituras siguen confirmándose en cada handler.
 */
export function reconcilePlans(args: ReconcileArgs): ReconcileResult {
  const { deterministic: det, plannerActions, plannerDomains, plannerError, allowedDomains, hasBlockingPending } = args

  if (plannerError || !plannerActions || plannerActions.length === 0) {
    return { plan: det, source: 'deterministic', reason: 'planner_unavailable' }
  }
  if (det.clarifyHandled) {
    return { plan: det, source: 'deterministic', reason: 'clarify_pending' }
  }
  if (det.dispatchedTo === 'voucher' || plannerDomains.includes('voucher')) {
    return { plan: det, source: 'deterministic', reason: 'voucher_frozen' }
  }

  const primary = plannerActions[0]
  const domain = actionDomain(primary)
  if (!domain) {
    return { plan: det, source: 'deterministic', reason: 'no_domain' }
  }
  if (domain === 'voucher') {
    return { plan: det, source: 'deterministic', reason: 'voucher_frozen' }
  }
  if (!allowedDomains.has(domain)) {
    return { plan: det, source: 'deterministic', reason: 'domain_disabled' }
  }
  if (hasBlockingPending && domain !== det.dispatchedTo) {
    return { plan: det, source: 'deterministic', reason: 'pending_protected' }
  }
  // Fase 5: una escritura del planner sólo pasa si está habilitada explícitamente.
  // Aun habilitada, el handler del dominio es quien confirma (gastos/asistencia/presupuesto).
  if (isWriteAction(primary) && !args.allowsWrites) {
    return { plan: det, source: 'deterministic', reason: 'writes_disabled' }
  }

  // Fase 5: la policy real se aplica también a las acciones del planner.
  const gated = applyPolicy(plannerActions, {
    maxWritesPerTurn: 1,
    originalText: args.originalText,
    seenWriteKeys: args.seenWriteKeys,
  })
  if (gated.length === 0) {
    return { plan: det, source: 'deterministic', reason: 'policy_blocked' }
  }

  return {
    plan: {
      ...det,
      dispatchedTo: domain,
      dispatchReason: 'planner',
      actions: gated,
      responded: true,
    },
    source: 'planner',
    reason: 'planner_drives',
  }
}
