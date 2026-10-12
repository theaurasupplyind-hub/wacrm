import type { TurnAction } from './actions'

/**
 * Policy layer + activación por dominio del planner.
 *
 * FASE 1: `applyPolicy` es identidad (paridad con el determinístico).
 * FASE 4: el planner conduce por dominio (`ASSISTANT_PLANNER_DOMAINS`).
 * FASE 5 (esta): `applyPolicy` pasa a ser real:
 *   - a lo sumo `maxWritesPerTurn` (default 1) escrituras por turno;
 *   - el texto de toda escritura es el del USUARIO, nunca el que inventó el
 *     modelo (los montos/IDs salen de tools/handlers, no del LLM);
 *   - dedupe de escrituras idénticas dentro del turno (idempotencia best-effort);
 *   - las escrituras del planner requieren habilitación EXPLÍCITA
 *     (`ASSISTANT_PLANNER_WRITES=true`); por defecto el planner sólo conduce
 *     lectura. Aun habilitadas, el handler de cada dominio sigue confirmando.
 */

/** Dominios que el planner puede conducir (voucher queda congelado). */
export type PlannerDomain = 'expense' | 'attendance' | 'pedido' | 'assistant'

const ALL_PLANNER_DOMAINS: readonly PlannerDomain[] = ['assistant', 'pedido', 'expense', 'attendance']

/**
 * Dominios habilitados para el planner, desde `ASSISTANT_PLANNER_DOMAINS`.
 * Default vacío → el planner no conduce nada (sólo sombra si está en `shadow`).
 * Orden de activación sugerido (lectura primero): assistant → pedido → expense → attendance.
 */
export function getPlannerDomains(): Set<PlannerDomain> {
  const raw = (process.env.ASSISTANT_PLANNER_DOMAINS || '').trim().toLowerCase()
  const out = new Set<PlannerDomain>()
  if (!raw) return out
  for (const part of raw.split(',').map((s) => s.trim())) {
    if ((ALL_PLANNER_DOMAINS as readonly string[]).includes(part)) out.add(part as PlannerDomain)
  }
  return out
}

/**
 * Fase 5: por defecto el planner NO puede conducir escrituras. Requiere
 * `ASSISTANT_PLANNER_WRITES=true` (además de tener el dominio habilitado).
 */
export function plannerWritesEnabled(): boolean {
  return (process.env.ASSISTANT_PLANNER_WRITES || '').trim().toLowerCase() === 'true'
}

/** Mapea la acción primaria propuesta por el planner a su dominio. */
export function actionDomain(action: TurnAction): PlannerDomain | 'voucher' | null {
  switch (action.kind) {
    case 'run_expense':
      return 'expense'
    case 'run_attendance':
      return 'attendance'
    case 'run_order':
      return 'pedido'
    case 'run_assistant':
    case 'reply_text':
      return 'assistant'
    case 'run_voucher_text':
    case 'run_voucher_message_text':
      return 'voucher'
    default:
      return null
  }
}

/** Acciones que cuentan como escritura de negocio. */
export const WRITE_ACTIONS: ReadonlySet<TurnAction['kind']> = new Set([
  'run_expense',
  'run_attendance',
  'run_order',
  'run_voucher_text',
  'run_voucher_message_text',
])

export function isWriteAction(action: TurnAction): boolean {
  return WRITE_ACTIONS.has(action.kind)
}

/** Clave estable para deduplicar escrituras dentro del turno (idempotencia). */
export function writeKey(action: TurnAction): string {
  switch (action.kind) {
    case 'run_expense':
    case 'run_attendance':
    case 'run_order':
    case 'run_voucher_message_text':
      return `${action.kind}:${action.text}`
    case 'run_voucher_text':
      return `run_voucher_text:${action.clientName}:${action.monto ?? ''}:${action.fecha ?? ''}`
    default:
      return action.kind
  }
}

export interface PolicyContext {
  /** Máximo de escrituras por turno. Default 1 (Fase 5). */
  maxWritesPerTurn?: number | null
  /** Texto original del usuario; la escritura debe usarlo textualmente. */
  originalText?: string
  /** Set de escrituras ya vistas en el turno (dedupe/idempotencia). */
  seenWriteKeys?: Set<string>
}

export const DEFAULT_POLICY: PolicyContext = { maxWritesPerTurn: 1 }

/**
 * Devuelve las acciones permitidas.
 *
 * Invariantes de Fase 5:
 *  1. `maxWritesPerTurn` (default 1): se descartan escrituras extra.
 *  2. El texto de una escritura NUNCA es el del modelo: si difiere del texto del
 *     usuario, se reemplaza por el original (los montos/IDs vienen de tools).
 *  3. Dedupe: una misma escritura (misma clave) no se emite dos veces.
 */
export function applyPolicy(actions: TurnAction[], ctx: PolicyContext = DEFAULT_POLICY): TurnAction[] {
  const max = ctx.maxWritesPerTurn ?? 1
  const seen = ctx.seenWriteKeys
  const out: TurnAction[] = []
  let writes = 0

  for (const raw of actions) {
    let action = raw

    if (isWriteAction(action)) {
      // (2) El texto lo manda el usuario, no el LLM.
      if (ctx.originalText != null && 'text' in action && action.text !== ctx.originalText) {
        action = { ...action, text: ctx.originalText } as TurnAction
      }
      // (1) Tope de escrituras por turno.
      if (writes >= max) continue
      // (3) Idempotencia: no repetir la misma escritura.
      const key = writeKey(action)
      if (seen) {
        if (seen.has(key)) continue
        seen.add(key)
      }
      writes++
    }

    out.push(action)
  }

  return out
}
