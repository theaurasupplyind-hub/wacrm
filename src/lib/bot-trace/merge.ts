/**
 * Merge append-only de trazas del mismo mensaje.
 *
 * Varios productores (webhook/router, voucher-pipeline, assistant) pueden
 * registrar la MISMA `message_id` en distinto orden. Reglas:
 *   - `path`: se une preservando el orden existente y agregando ids nuevos.
 *   - `steps`: se deduplican por `id`; el existente manda (nunca se pisa).
 *   - `status`: gana el de mayor prioridad (los estados terminales concretos
 *     valen más que `unknown`/`dispatchedTo`).
 */

import type { BotTrace } from './schema'

const STATUS_RANK: Record<string, number> = {
  matched: 5,
  multi_invoice: 5,
  ambiguous: 4,
  no_match: 4,
  error: 4,
  replied: 2,
  clarify: 2,
  voucher: 1,
  expense: 1,
  attendance: 1,
  voice: 1,
  assistant: 1,
  unknown: 0,
}

function pickStatus(a: string, b: string): string {
  const ra = STATUS_RANK[a] ?? 1
  const rb = STATUS_RANK[b] ?? 1
  if (ra !== rb) return ra >= rb ? a : b
  // Empate: preferir el que no sea `unknown`.
  if (a === 'unknown') return b
  return a
}

export function mergeBotTraces(base: BotTrace, incoming: BotTrace): BotTrace {
  const path = [...base.path]
  for (const id of incoming.path) {
    if (!path.includes(id)) path.push(id)
  }

  const ids = new Set(base.steps.map((s) => s.id))
  const steps = [...base.steps]
  for (const step of incoming.steps) {
    if (!ids.has(step.id)) {
      ids.add(step.id)
      steps.push(step)
    }
  }

  return {
    messageId: base.messageId,
    conversationId: base.conversationId ?? incoming.conversationId ?? null,
    contactId: base.contactId ?? incoming.contactId ?? null,
    accountId: base.accountId ?? incoming.accountId ?? null,
    source: base.source ?? incoming.source ?? null,
    rawText: base.rawText ?? incoming.rawText ?? null,
    path,
    steps,
    status: pickStatus(base.status, incoming.status),
    errorMessage: base.errorMessage ?? incoming.errorMessage ?? null,
    createdAt: base.createdAt ?? incoming.createdAt,
  }
}
