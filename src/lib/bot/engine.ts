import type { BotIntent, UnifiedExtraction } from '@/lib/bot-llm/types'
import type { ClarifyContextState } from '@/lib/bot-llm/clarify-context'
import type { AwaitingClientMatch } from '@/lib/ai/voucher-context'
import type { MatchVoucherCandidate } from '@/lib/facbal/client'
import { decideDispatch } from '@/lib/bot/router'
import { buildJevPending } from '@/lib/bot-llm/classify-jev'
import { detectAmbiguity, matchClarifyOption } from '@/lib/bot-llm/ambiguity'
import { resolveClarifyExtraction } from '@/lib/bot-llm/clarify-context'
import { isVoucherClarificationReply, extractClientNameFromReply } from '@/lib/ai/voucher-pipeline'
import { isAwaitingMatchFresh } from '@/lib/ai/voucher-context'
import { sanitizeClientName } from '@/lib/ai/voucher-matching'
import { parseMontoSafe } from '@/lib/bot-llm/sanitize'
import type { BotVocabulary } from '@/lib/catalog/vocabulary'
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
  /** Follow-up "no encontré facturas para X": el próximo mensaje puede ser el monto o el nombre. */
  voucherAwaitingMatch?: AwaitingClientMatch | null
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
  /** Vocabulario del catálogo para los gates (Plan A1). Opcional: fail-open. */
  vocab?: BotVocabulary | null
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
  'No pude registrar el pago. Pasame el monto (y el nombre si lo tenés) y si fue en efectivo o transferencia. Ej: "Martu pagó 422000 en efectivo".'
const FALLBACK_TEXT_MSG =
  'No te entendí 🤔 ¿me repetís? Puedo registrar gastos, pagos/comprobantes o asistencias, y consultar saldos de clientes.'
const FALLBACK_MEDIA_MSG =
  'No pude leer eso 🤔 Mandame el detalle por texto (ej: "gasté 5000 en luz") o una foto del comprobante.'

// ── Follow-up de voucher ("no encontré facturas para X") ──
const AWAITING_MATCH_CANCEL_RE =
  /^(cancelar|cancelo|no|mejor no|olvidalo|olvídalo|dejalo|dejalo asi|nada)$/i
const AWAITING_MATCH_STOPWORDS = new Set([
  'hola', 'buenas', 'buenos dias', 'buenas tardes', 'buenas noches',
  'gracias', 'ok', 'dale', 'listo', 'si', 'no', 'nada', 'cancelar', 'cancelo',
])
const AWAITING_MATCH_AMOUNT_RE = /^[\s$]*\d[\d.,]*(?:\s*(mil|k|m))?[\s$]*$/i
const AWAITING_MATCH_EXPENSE_VERB_RE =
  /\b(gast|compr|pagu[eé]|abon[eé]|transfer[ií]|deposit[eé])\b/i
const AWAITING_MATCH_PAYMENT_VERB_RE =
  /\b(pag[oó]|paga|pagaron|abon[oó]|transfiri[oó]|efectivo|tarjeta|mercado)\b/i

/**
 * El follow-up puede ser un monto puro ("422000", "$422.000", "422 mil") o
 * una frase corta sin verbos de gasto/pago ("son 422000"). Nunca tomar
 * "gasté 5000" como monto de un cobro.
 */
function extractAwaitingAmountReply(
  text: string,
  extraction: UnifiedExtraction | null,
): number | null {
  const t = text.trim()
  if (!t) return null
  if (AWAITING_MATCH_EXPENSE_VERB_RE.test(t) || AWAITING_MATCH_PAYMENT_VERB_RE.test(t)) return null
  if (AWAITING_MATCH_AMOUNT_RE.test(t)) return parseMontoSafe(t)
  const intentOk = !extraction || extraction.intent === 'otro' || extraction.intent === 'voucher'
  return intentOk ? extraction?.monto ?? null : null
}

/** El follow-up también puede ser el nombre completo del cliente. */
function extractAwaitingNameReply(
  text: string,
  extraction: UnifiedExtraction | null,
): string | null {
  const t = text.trim()
  if (!t || /[?¿]/.test(t) || /\d/.test(t)) return null
  if (AWAITING_MATCH_PAYMENT_VERB_RE.test(t)) return null
  const norm = t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  if (AWAITING_MATCH_STOPWORDS.has(norm)) return null
  return sanitizeClientName(extraction?.proveedor) ?? extractClientNameFromReply(t)
}

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

  // ── VOUCHER: follow-up de "no encontré facturas para X" ──
  // El mensaje anterior pidió el monto o el nombre completo. Se consume acá
  // (antes del clarify/router) para que un nombre suelto no caiga al assistant.
  let awaitingHandled = false
  const awaiting = state.voucherAwaitingMatch ?? null
  if (
    botAllowed &&
    !flowConsumed &&
    !clarifyLoad &&
    !interactiveReplyId &&
    inboundText.trim() &&
    isAwaitingMatchFresh(awaiting) &&
    !hasPendingVoucher &&
    !hasPendingExpense &&
    !hasPendingAttendance &&
    !hasPendingOrder
  ) {
    const text = inboundText.trim()
    if (AWAITING_MATCH_CANCEL_RE.test(text)) {
      actions.push({ kind: 'clear_voucher_awaiting' })
      actions.push({
        kind: 'reply_text',
        text: 'Listo, no registré ningún pago. Si querés retomar, mandame de nuevo el mensaje.',
      })
      responded = true
      awaitingHandled = true
    } else {
      const amount = extractAwaitingAmountReply(text, extraction)
      const name = amount == null ? extractAwaitingNameReply(text, extraction) : null
      const strongNonVoucher = isStrongNewIntent(extraction) && extraction?.intent !== 'voucher'

      if (amount != null) {
        actions.push({ kind: 'clear_voucher_awaiting' })
        actions.push({
          kind: 'run_voucher_text',
          clientName: awaiting!.attemptedName ?? '',
          destName: awaiting!.destName,
          metodoPago: awaiting!.metodoPago,
          monto: amount,
          fecha: awaiting!.fecha,
        })
        responded = true
        awaitingHandled = true
      } else if (name && !strongNonVoucher) {
        actions.push({ kind: 'clear_voucher_awaiting' })
        actions.push({
          kind: 'run_voucher_text',
          clientName: name,
          destName: awaiting!.destName,
          metodoPago: awaiting!.metodoPago,
          monto: awaiting!.monto,
          fecha: awaiting!.fecha,
        })
        responded = true
        awaitingHandled = true
      } else {
        // Cambió de tema o mandó algo que no es nombre/monto: no dejar el
        // estado colgado; el flujo normal decide.
        actions.push({ kind: 'clear_voucher_awaiting' })
      }
    }
  }

  // ── CLARIFY (preguntar ante ambigüedad y resolver) ──
  if (!awaitingHandled && botAllowed && !flowConsumed && (inboundText.trim() || interactiveReplyId)) {
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
    : awaitingHandled
      ? { dispatchedTo: 'voucher' as const, dispatchReason: 'voucher_awaiting_match' as const }
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
          vocab: state.vocab ?? null,
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
  // Si el media ya lo tomó el pipeline de voucher (imagen/PDF con caption), el
  // caption es contexto de ESA pieza, no un voucher de texto aparte: procesarlo
  // acá duplicaba la extracción (dos filas para el mismo message_id) y el pago
  // podía registrarse dos veces. Ver docs/bots/decisiones-y-gotchas.md §11.1.
  if (botAllowed && !clarifyHandled && !mediaConsumedByVoucher && !awaitingHandled) {
    const montoVoucherText = extraction?.monto ?? null
    const metodoVoucherText =
      extraction?.metodo_pago === 'efectivo' || (!extraction?.metodo_pago && inboundText.toLowerCase().includes('efectivo'))
        ? ('Efectivo' as const)
        : extraction?.metodo_pago === 'transferencia' || (!extraction?.metodo_pago && inboundText.toLowerCase().includes('transferencia'))
          ? ('Transferencia' as const)
          : null
    // El nombre no es obligatorio si hay monto: el monto es el ancla más
    // fuerte (Fase 1 del pipeline). "me pagaron 422000 en efectivo" debe
    // poder registrar/buscar aunque no sepamos el cliente.
    const hasVoucherAnchor =
      !!extraction?.proveedor || (montoVoucherText != null && montoVoucherText > 0)
    const isVoucherText =
      !hasPendingVoucher &&
      !flowConsumed &&
      (!interactiveReplyId || clarifyResolved) &&
      inboundText.trim() &&
      extraction?.intent === 'voucher' &&
      (montoVoucherText == null || montoVoucherText > 0) &&
      hasVoucherAnchor &&
      metodoVoucherText != null

    if (isVoucherText && metodoVoucherText) {
      actions.push({
        kind: 'run_voucher_text',
        clientName: extraction?.proveedor ?? '',
        destName: extraction?.destino ?? null,
        metodoPago: metodoVoucherText,
        monto: montoVoucherText,
        fecha: extraction?.fecha ?? null,
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

  // Voucher sin datos suficientes (sin nombre ni monto, o sin método): pedir
  // el dato que falta en vez del "No te entendí" genérico.
  if (
    botAllowed &&
    !responded &&
    !clarifyHandled &&
    !flowConsumed &&
    !interactiveReplyId &&
    extraction?.intent === 'voucher' &&
    messageType === 'text' &&
    inboundText.trim()
  ) {
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
