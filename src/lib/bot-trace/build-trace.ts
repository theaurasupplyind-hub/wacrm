/**
 * Constructor puro de `BotTrace`.
 *
 * A partir de datos ya disponibles en el webhook / lab (extraction, decisión
 * del router, logs del handler, debugInfo del voucher), arma el `path` de
 * nodos visitados y los `steps` con su detalle. Sin React, sin I/O: testeable.
 */

import {
  BotTraceSchema,
  type BotTrace,
  type TraceStep,
  type TraceStatus,
} from './schema'
import { dispatchNodeId } from './topology'

export interface ExtractionLike {
  intent?: string | null
  confianza?: string | null
  extractor_source?: string | null
  dudoso?: boolean | null
  jev_intent?: string | null
  jev_confidence?: number | null
  jev_pending_domain?: string | null
  jev_used?: boolean | null
  faltan_campos?: unknown
}

export interface HandlerLog {
  step: string
  data?: unknown
}

export interface BuildTraceInput {
  messageId: string
  /** Prefijo de los `step.id` para que productores distintos no colisionen. */
  producer?: string
  conversationId?: string | null
  contactId?: string | null
  accountId?: string | null
  source?: string | null
  rawText?: string | null
  messageType?: string | null
  /** Contextos multi-turn activos al momento del mensaje. */
  contextFlags?: {
    expense?: boolean
    attendance?: boolean
    voucher?: boolean
    voice?: boolean
    clarify?: boolean
  }
  extraction?: ExtractionLike | null
  contextText?: string | null
  dispatchedTo?: string | null
  dispatchReason?: string | null
  /** debugInfo de fases 1-5 del voucher (producción o dry-run). */
  voucherDebug?: unknown | null
  voucherStatus?: string | null
  /** Logs ordenados del handler (unified-handler / assistant orchestrator). */
  logs?: HandlerLog[]
  finalStatus?: string | null
  errorMessage?: string | null
}

/** Mapea el nombre de un log del handler a un nodo de la topología. */
function mapLogToNode(step: string): string {
  const s = step.toLowerCase()
  if (s.includes('router') || s.includes('dispatch')) return 'router'
  if (s.includes('extract') || s.includes('jev') || s.includes('ambigu')) return 'extract'
  if (s.includes('voucher') || s.includes('payment') || s.includes('pago')) return 'h_voucher_media'
  if (s.includes('expense') || s.includes('gasto')) return 'h_expense'
  if (s.includes('attendance') || s.includes('asistencia')) return 'h_attendance'
  if (s.includes('voice') || s.includes('transcri')) return 'h_voice'
  if (s.includes('tool') || s.includes('knowledge') || s.includes('assistant')) return 'h_assistant'
  if (s.includes('clarify')) return 'h_clarify'
  if (s.includes('context')) return 'webhook'
  return 'webhook'
}

function handlerNodeFor(dispatchedTo: string | null | undefined): string | null {
  switch (dispatchedTo) {
    case 'expense':
      return 'h_expense'
    case 'attendance':
      return 'h_attendance'
    case 'voucher':
      return 'h_voucher_media'
    case 'voice':
      return 'h_voice'
    case 'assistant':
      return 'h_assistant'
    case 'clarify':
      return 'h_clarify'
    case 'flow':
      return 'h_flow'
    default:
      return null
  }
}

function terminalNodeFor(
  finalStatus: string | null | undefined,
  dispatchedTo: string | null | undefined,
): string {
  switch (finalStatus) {
    case 'matched':
      return 't_matched'
    case 'ambiguous':
      return 't_ambiguous'
    case 'multi_invoice':
      return 't_multi_invoice'
    case 'no_match':
      return 't_no_match'
    default:
      break
  }
  if (dispatchedTo === 'clarify') return 't_clarify_ask'
  if (!dispatchedTo || dispatchedTo === 'none') return 't_no_match'
  return 't_replied'
}

/**
 * Construye la traza. Las ramas de media (voucher/gasto/voz) suceden ANTES
 * del cerebro de texto, así que se ubican primero en el `path`.
 */
export function buildBotTrace(input: BuildTraceInput): BotTrace {
  const path: string[] = []
  const steps: TraceStep[] = []
  const start = Date.now()
  const producer = input.producer ?? 'trace'
  const nodeCount = new Map<string, number>()

  const pushNode = (nodeId: string) => {
    if (path[path.length - 1] !== nodeId && !path.includes(nodeId)) path.push(nodeId)
  }
  const pushStep = (
    nodeId: string,
    label: string,
    status: TraceStatus = 'ok',
    data?: unknown,
  ) => {
    const n = (nodeCount.get(nodeId) ?? 0) + 1
    nodeCount.set(nodeId, n)
    steps.push({
      id: `${producer}:${nodeId}#${n}`,
      nodeId,
      label,
      status,
      ts: Date.now() - start,
      data,
    })
  }

  // 1) Entrada.
  pushNode('webhook')
  pushStep('webhook', 'Mensaje recibido', 'ok', {
    source: input.source ?? input.messageType ?? null,
    text: input.rawText ?? null,
  })

  // 2) Contextos multi-turn activos.
  const flags = input.contextFlags ?? {}
  if (flags.expense) { pushNode('ctx_expense'); pushStep('ctx_expense', 'Contexto gasto activo') }
  if (flags.attendance) { pushNode('ctx_attendance'); pushStep('ctx_attendance', 'Contexto asistencia activo') }
  if (flags.voucher) { pushNode('ctx_voucher'); pushStep('ctx_voucher', 'Contexto voucher activo') }
  if (flags.voice) { pushNode('ctx_voice'); pushStep('ctx_voice', 'Contexto pedido activo') }
  if (flags.clarify) { pushNode('ctx_clarify'); pushStep('ctx_clarify', 'Contexto aclaración activo') }

  // 3) Rama de media (previa al cerebro de texto).
  const mediaType = input.source ?? input.messageType ?? ''
  if (input.voucherDebug != null) {
    const vStatus: TraceStatus = input.errorMessage ? 'error' : 'ok'
    pushNode('h_voucher_media')
    pushStep('h_voucher_media', 'Pipeline de voucher (fases 1-5)', vStatus, input.voucherDebug)
  } else if (mediaType === 'image' || mediaType === 'document') {
    pushNode('h_voucher_media')
    pushStep('h_voucher_media', 'Imagen/documento → voucher', 'skipped')
  }
  if (mediaType === 'audio') {
    pushNode('h_voice')
    pushStep('h_voice', 'Audio → transcripción / pedido', 'ok')
  }

  // 4) Cerebro de texto (extracción + router) si hubo texto.
  if (input.extraction || input.rawText) {
    pushNode('extract')
    pushStep('extract', 'Extracción LLM + Jev', 'ok', {
      intent: input.extraction?.intent ?? null,
      confianza: input.extraction?.confianza ?? null,
      extractor_source: input.extraction?.extractor_source ?? null,
      dudoso: input.extraction?.dudoso ?? null,
      jev_intent: input.extraction?.jev_intent ?? null,
      jev_confidence: input.extraction?.jev_confidence ?? null,
      jev_pending_domain: input.extraction?.jev_pending_domain ?? null,
      jev_used: input.extraction?.jev_used ?? null,
      contextText: input.contextText ?? null,
    })
  }

  if (input.dispatchedTo) {
    pushNode('router')
    pushStep('router', `Router → ${input.dispatchedTo}`, 'ok', {
      dispatchedTo: input.dispatchedTo,
      dispatchReason: input.dispatchReason ?? null,
    })
    const dNode = dispatchNodeId(input.dispatchedTo)
    if (dNode) {
      pushNode(dNode)
      pushStep(dNode, `Dispatch ${input.dispatchedTo}`, 'ok')
    }
    const hNode = handlerNodeFor(input.dispatchedTo)
    if (hNode) {
      pushNode(hNode)
      pushStep(hNode, `Handler ${input.dispatchedTo}`, 'ok')
    }
  }

  // 5) Logs del handler (si los hay) — se anexan a su nodo.
  for (const log of input.logs ?? []) {
    const nodeId = mapLogToNode(log.step)
    if (!path.includes(nodeId)) pushNode(nodeId)
    pushStep(nodeId, log.step, 'ok', log.data)
  }

  // 6) Terminal.
  const terminal = terminalNodeFor(input.finalStatus ?? input.voucherStatus, input.dispatchedTo)
  pushNode(terminal)
  pushStep(
    terminal,
    input.finalStatus ? `Estado final: ${input.finalStatus}` : 'Fin',
    input.errorMessage ? 'error' : 'ok',
    { errorMessage: input.errorMessage ?? null },
  )

  return BotTraceSchema.parse({
    messageId: input.messageId,
    conversationId: input.conversationId ?? null,
    contactId: input.contactId ?? null,
    accountId: input.accountId ?? null,
    source: input.source ?? input.messageType ?? null,
    rawText: input.rawText ?? null,
    path,
    steps,
    status: input.finalStatus ?? input.voucherStatus ?? input.dispatchedTo ?? 'unknown',
    errorMessage: input.errorMessage ?? null,
  })
}
