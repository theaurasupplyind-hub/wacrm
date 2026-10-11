/**
 * Arnés de replay de `router_logs`.
 *
 * Repite mensajes reales por el router (`decideDispatch`) para comparar la
 * decisión logueada contra la decisión actual y medir si los silencios
 * (`dispatched_to = none`) se corrigieron. Es agnóstico de la fuente de la
 * extracción: el test determinístico pasa la extracción guardada y el test
 * live pasa una extracción fresca del LLM.
 *
 * Notas de fidelidad:
 *  - Los flags de pendiente (`hasPending*`) no son columnas; se infieren de
 *    `context_text` (heurística). Las filas con `had_context=true` se marcan
 *    como "context-dependent" y no se assertean.
 *  - El gate de whitelist y el fallback de media viven en el webhook, no en
 *    `router_logs`; se cubren con tests aparte.
 */

import type { RouterState } from '@/lib/bot/router'
import { decideDispatch } from '@/lib/bot/router'
import { buildJevPending } from './classify-jev'
import type { UnifiedExtraction } from './types'

export interface RouterLogRow {
  message_id: string
  raw_text: string | null
  source: string | null
  flow_consumed: boolean | null
  interactive: boolean | null
  had_context: boolean | null
  intent: string | null
  confianza: string | null
  dispatched_to: string | null
  dispatch_reason: string | null
  context_text: string | null
  extraction: UnifiedExtraction | null
  contact_phone?: string | null
  created_at?: string
}

export interface PendingFlags {
  expense: boolean
  attendance: boolean
  voucher: boolean
}

/** Infiere los flags de contexto pendiente a partir del `context_text` logueado. */
export function inferPendingFlags(contextText: string | null | undefined): PendingFlags {
  const t = contextText ?? ''
  return {
    expense: /Gasto pendiente|Gastos m[uú]ltiples pendientes|corregir la categor/i.test(t),
    attendance: /Asistencia pendiente|Asistencia:/i.test(t),
    voucher: /Voucher: hay/i.test(t),
  }
}

export interface ReplayStateInput {
  row: RouterLogRow
  extraction: UnifiedExtraction | null
  interactiveReplyId?: string | null
}

/** Reconstruye el `RouterState` que el webhook le habría pasado a `decideDispatch`. */
export function buildReplayState(input: ReplayStateInput): RouterState {
  const { row, extraction } = input
  const flags = inferPendingFlags(row.context_text)
  return {
    hasPendingExpense: flags.expense,
    hasPendingAttendance: flags.attendance,
    hasPendingVoucher: flags.voucher,
    flowConsumed: !!row.flow_consumed,
    interactiveReplyId: input.interactiveReplyId ?? null,
    inboundText: row.raw_text ?? '',
    extraction,
    mediaConsumedByVoucher: row.source === 'image' || row.source === 'document',
    jevPending: buildJevPending(extraction),
  }
}

export interface ReplayCase {
  messageId: string
  rawText: string
  source: string | null
  oldIntent: string | null
  newIntent: string | null
  oldDispatch: string | null
  newDispatch: string
  newReason: string
  intentChanged: boolean
  dispatchChanged: boolean
  wasSilence: boolean
  silenceFixed: boolean
  /** La fila dependía de contexto pendiente: el replay puede diferir legítimamente. */
  contextDependent: boolean
}

export function replayRow(
  row: RouterLogRow,
  extraction: UnifiedExtraction | null,
): ReplayCase {
  const decision = decideDispatch(buildReplayState({ row, extraction }))
  const oldDispatch = row.dispatched_to
  const wasSilence = oldDispatch === 'none'
  return {
    messageId: row.message_id,
    rawText: row.raw_text ?? '',
    source: row.source,
    oldIntent: row.intent,
    newIntent: extraction?.intent ?? null,
    oldDispatch,
    newDispatch: decision.dispatchedTo,
    newReason: decision.dispatchReason,
    intentChanged: (extraction?.intent ?? null) !== row.intent,
    dispatchChanged: decision.dispatchedTo !== oldDispatch,
    wasSilence,
    silenceFixed: wasSilence && decision.dispatchedTo !== 'none',
    contextDependent: !!row.had_context,
  }
}

export interface ReplayReport {
  total: number
  intentAccuracy: number
  dispatchChanged: number
  silencesBefore: number
  silencesFixed: number
  silencesRemaining: number
  cases: ReplayCase[]
}

export function summarizeReplay(cases: ReplayCase[]): ReplayReport {
  const withIntent = cases.filter((c) => c.oldIntent != null)
  const intentCorrect = withIntent.filter((c) => c.newIntent === c.oldIntent).length
  return {
    total: cases.length,
    intentAccuracy: withIntent.length > 0 ? intentCorrect / withIntent.length : 0,
    dispatchChanged: cases.filter((c) => c.dispatchChanged).length,
    silencesBefore: cases.filter((c) => c.wasSilence).length,
    silencesFixed: cases.filter((c) => c.silenceFixed).length,
    silencesRemaining: cases.filter((c) => c.wasSilence && c.newDispatch === 'none').length,
    cases,
  }
}

export function formatReplayReport(report: ReplayReport): string {
  const lines: string[] = []
  lines.push(
    `Replay: ${report.total} casos · intent ${(report.intentAccuracy * 100).toFixed(1)}% · ` +
      `dispatch cambiado ${report.dispatchChanged} · ` +
      `silencios ${report.silencesBefore} → arreglados ${report.silencesFixed} (quedan ${report.silencesRemaining})`,
  )
  const changed = report.cases.filter((c) => c.dispatchChanged && !c.contextDependent)
  if (changed.length > 0) {
    lines.push('Cambios de dispatch (sin contexto pendiente):')
    for (const c of changed) {
      lines.push(
        `  - "${c.rawText.slice(0, 60)}" [${c.source}] ${c.oldDispatch} → ${c.newDispatch} (${c.newReason})`,
      )
    }
  }
  const fixed = report.cases.filter((c) => c.silenceFixed)
  if (fixed.length > 0) {
    lines.push('Silencios arreglados:')
    for (const c of fixed) {
      lines.push(`  - "${c.rawText.slice(0, 60)}" [${c.source}] none → ${c.newDispatch}`)
    }
  }
  return lines.join('\n')
}

/** Filas con texto que tiene sentido re-extraer con el LLM. */
export function isTextReplayable(row: RouterLogRow): boolean {
  return row.source === 'text' && !!row.raw_text?.trim()
}
