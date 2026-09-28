/**
 * Schema type-safe del flujo/traza del bot (Zod = fuente de verdad).
 *
 * Un `BotTrace` es el recorrido de UN mensaje por el flujo: los nodos
 * visitados (`path`), el detalle de cada paso (`steps`) y el estado final.
 * Lo consumen:
 *   - el diagrama visual (`/bot-flow`),
 *   - la persistencia (`recordBotTrace` → tabla `bot_traces`),
 *   - la validación de salidas del LLM/Jev (normaliza shapes de debug).
 *
 * Mantener estos tipos espejados con `src/lib/bot-trace/topology.ts`.
 */

import { z } from 'zod'

export const TRACE_STATUSES = ['ok', 'skipped', 'error', 'pending'] as const
export const TraceStatusSchema = z.enum(TRACE_STATUSES)
export type TraceStatus = z.infer<typeof TraceStatusSchema>

/** Un paso concreto dentro de un nodo de la topología. */
export const TraceStepSchema = z.object({
  /** Id estable del paso (p. ej. `router:decide`, `voucher:phase1`). */
  id: z.string(),
  /** Nodo de `BOT_TOPOLOGY` al que pertenece. */
  nodeId: z.string(),
  /** Etiqueta legible para el panel/timeline. */
  label: z.string(),
  status: TraceStatusSchema.default('ok'),
  /** Timestamp relativo (ms desde el inicio de la traza) o epoch. */
  ts: z.number().optional(),
  durationMs: z.number().optional(),
  /** Payload libre por paso (extracción, candidatos, decisión, etc.). */
  data: z.unknown().optional(),
})
export type TraceStep = z.infer<typeof TraceStepSchema>

/** Terminales del flujo (estados finales posibles). */
export const TRACE_TERMINALS = [
  'matched',
  'ambiguous',
  'multi_invoice',
  'no_match',
  'clarify',
  'replied',
  'unknown',
] as const
export const TraceTerminalSchema = z.enum(TRACE_TERMINALS)
export type TraceTerminal = z.infer<typeof TraceTerminalSchema>

export const BotTraceSchema = z.object({
  messageId: z.string(),
  conversationId: z.string().nullable().optional(),
  contactId: z.string().nullable().optional(),
  accountId: z.string().nullable().optional(),
  /** Tipo de mensaje de entrada (`text|image|document|audio|interactive...`). */
  source: z.string().nullable().optional(),
  rawText: z.string().nullable().optional(),
  /** Ids de nodos visitados, en orden. */
  path: z.array(z.string()).default([]),
  steps: z.array(TraceStepSchema).default([]),
  /** Estado final de la traza. */
  status: z.string().default('unknown'),
  errorMessage: z.string().nullable().optional(),
  /** ISO string; lo completa la DB si falta. */
  createdAt: z.string().optional(),
})
export type BotTrace = z.infer<typeof BotTraceSchema>

/** Fila tal como la devuelve la tabla `bot_traces`. */
export const BotTraceRowSchema = BotTraceSchema.extend({
  id: z.union([z.number(), z.string()]).optional(),
})
export type BotTraceRow = z.infer<typeof BotTraceRowSchema>

/** Parse defensivo: nunca lanza, devuelve null si la fila no matchea. */
export function parseBotTrace(input: unknown): BotTrace | null {
  const result = BotTraceSchema.safeParse(input)
  return result.success ? result.data : null
}

/** Normaliza una fila cruda de Supabase (snake_case) a `BotTrace`. */
export function rowToBotTrace(row: Record<string, unknown>): BotTrace | null {
  return parseBotTrace({
    messageId: row.message_id,
    conversationId: row.conversation_id ?? null,
    contactId: row.contact_id ?? null,
    accountId: row.account_id ?? null,
    source: row.source ?? null,
    rawText: row.raw_text ?? null,
    path: row.path ?? [],
    steps: row.steps ?? [],
    status: row.status ?? 'unknown',
    errorMessage: row.error_message ?? null,
    createdAt: row.created_at ?? undefined,
  })
}
