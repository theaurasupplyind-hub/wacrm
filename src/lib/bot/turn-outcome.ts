import type { SupabaseClient } from '@supabase/supabase-js'
import type { UnifiedExtraction } from '@/lib/bot-llm/types'

/**
 * Resultado del último turno del bot (persistido en
 * `conversations.bot_last_turn`).
 *
 * Se usa para dos disparadores del fallback LLM:
 *   1. El handler determinístico no respondió (`declined` / `no_reply` / `error`).
 *   2. El usuario reintenta después de un callejón sin salida
 *      (`replied_dead_end`, p. ej. "No te entendí 🤔 ¿me repetís?").
 *
 * Sin este estado el reintento no se detecta: el router volvería a mandar el
 * mismo mensaje al mismo handler que ya falló.
 */
export type TurnStatus =
  | 'processing'
  | 'replied'
  | 'replied_dead_end'
  | 'declined'
  | 'no_reply'
  | 'error'
  | 'blocked'
  | 'fallback_replied'

export interface LastTurn {
  messageId: string
  text: string
  domain: string
  reason: string
  status: TurnStatus
  at: string
  /** Dominio que falló y disparó el fallback (solo en `fallback_replied`). */
  fallbackFrom?: string | null
}

/** Lo que devuelve cada handler determinístico al adapter del webhook. */
export interface HandlerOutcome {
  handled: boolean
  replied: boolean
  text?: string | null
  error?: string | null
  /** El handler escribió (expenseId/presupuesto creado): el fallback no repite. */
  wrote?: boolean
}

const DEFAULT_RETRY_TTL_MS = 10 * 60 * 1000

/** Dominios que pueden entrar al fallback (`ASSISTANT_FALLBACK_DOMAINS`). */
const FALLBACK_DOMAINS: readonly string[] = ['expense', 'attendance', 'pedido']

/**
 * Fase 1: por defecto el fallback está activo para expense + attendance.
 * `ASSISTANT_FALLBACK_DOMAINS=` (vacío) o `=off` lo apaga; una lista explícita
 * habilita solo esos dominios (pedido queda opt-in).
 */
const DEFAULT_FALLBACK_DOMAINS: readonly string[] = ['expense', 'attendance']

/** Estados que habilitan el takeover del agente en el mensaje siguiente. */
const RETRY_STATUSES: ReadonlySet<TurnStatus> = new Set([
  'declined',
  'no_reply',
  'error',
  'replied_dead_end',
])

/** Intents con confianza alta/media que NO deben ser secuestrados por el retry. */
const STRONG_RETRY_INTENTS: ReadonlySet<string> = new Set([
  'gasto',
  'multi_expense',
  'voucher',
  'pedido',
  'asistencia_llegada',
  'asistencia_salida',
  'asistencia_estado',
])

export function getRetryTtlMs(): number {
  const raw = Number(process.env.ASSISTANT_FALLBACK_RETRY_TTL_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RETRY_TTL_MS
}

/** Dominios habilitados para el fallback. Sin env = expense+attendance. */
export function getFallbackDomains(): Set<string> {
  const raw = process.env.ASSISTANT_FALLBACK_DOMAINS
  if (raw == null) return new Set(DEFAULT_FALLBACK_DOMAINS)
  const normalized = raw.trim().toLowerCase()
  // `=off` o vacío explícito apagan el fallback (conducta previa).
  if (!normalized || normalized === 'off') return new Set()
  const out = new Set<string>()
  for (const part of normalized.split(',').map((s) => s.trim())) {
    if (FALLBACK_DOMAINS.includes(part)) out.add(part)
  }
  return out
}

/**
 * El fallback puede escribir mientras el gate de efectos + pending-confirm +
 * undo sigan vigentes. `ASSISTANT_FALLBACK_WRITES=false` lo deja en lectura.
 */
export function fallbackWritesEnabled(): boolean {
  return (process.env.ASSISTANT_FALLBACK_WRITES || '').trim().toLowerCase() !== 'false'
}

/** Parse defensivo de la columna JSONB (nunca lanza). */
export function parseLastTurn(value: unknown): LastTurn | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.messageId !== 'string' || typeof v.text !== 'string') return null
  if (typeof v.status !== 'string' || typeof v.at !== 'string') return null
  return {
    messageId: v.messageId,
    text: v.text,
    domain: typeof v.domain === 'string' ? v.domain : 'unknown',
    reason: typeof v.reason === 'string' ? v.reason : '',
    status: v.status as TurnStatus,
    at: v.at,
    fallbackFrom: typeof v.fallbackFrom === 'string' ? v.fallbackFrom : null,
  }
}

/**
 * ¿El mensaje siguiente debe considerarse un reintento? Solo si el turno
 * anterior terminó sin respuesta útil y sigue dentro del TTL.
 */
export function isRetryWorthy(
  last: LastTurn | null,
  now = Date.now(),
  ttlMs = getRetryTtlMs(),
): boolean {
  if (!last || !last.text.trim()) return false
  if (!RETRY_STATUSES.has(last.status)) return false
  const at = Date.parse(last.at)
  if (!Number.isFinite(at)) return false
  const delta = now - at
  // delta < 0 = reloj adelantado/clock skew: no tratamos como reintento.
  return delta >= 0 && delta <= ttlMs
}

const DEAD_END_PATTERNS: readonly RegExp[] = [
  /\bno te entendi\b/,
  /\bno (?:lo |la |te )?entendi\b/,
  /\bsigo sin entender\b/,
  /\bno pude (?:identificar|armar|procesar|registrar|interpretar|aplicar|actualizar|recuperar|guardar)\b/,
  /\bno se pudo (?:registrar|guardar|procesar|actualizar|recuperar)\b/,
  /\bno se detectaron items\b/,
  /\bno encontre (?:esa|ese|el|la|ningun|ninguna)\b/,
]

/**
 * ¿La respuesta del handler es un callejón sin salida? Es la señal que
 * convierte el turno en `replied_dead_end` para que el próximo mensaje lo
 * pueda tomar el agente.
 */
export function isDeadEndReply(text: string | null | undefined): boolean {
  if (!text || !text.trim()) return false
  const norm = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
  return DEAD_END_PATTERNS.some((re) => re.test(norm))
}

/** ¿Corresponde fallback para este resultado determinístico? */
export function shouldFallback(args: {
  domain: string
  replied: boolean
  wrote?: boolean
  enabled?: Set<string>
}): boolean {
  const enabled = args.enabled ?? getFallbackDomains()
  if (!enabled.has(args.domain)) return false
  // Si el handler escribió, una segunda ejecución duplicaría. La respuesta
  // faltante se cubre con el anti-silencio del handler, no con el agente.
  if (args.wrote) return false
  return !args.replied
}

/** Intent fuerte: el usuario cambió de tema y el determinístico conserva la prioridad. */
export function isStrongIntentForRetry(extraction: UnifiedExtraction | null): boolean {
  if (!extraction) return false
  if (extraction.confianza !== 'alta' && extraction.confianza !== 'media') return false
  return STRONG_RETRY_INTENTS.has(extraction.intent)
}

/**
 * ¿El reintento lo toma directamente el agente? Exige que no haya un pendiente
 * activo (slot/clarify/voucher/pedido) ni un intent fuerte nuevo.
 */
export function shouldTakeoverRetry(args: {
  last: LastTurn | null
  botAllowed: boolean
  hasPending: boolean
  strongNewIntent: boolean
  clarifyHandled: boolean
  now?: number
}): boolean {
  if (!args.botAllowed) return false
  if (args.hasPending || args.strongNewIntent || args.clarifyHandled) return false
  return isRetryWorthy(args.last, args.now)
}

const STATUS_LABELS: Record<TurnStatus, string> = {
  processing: 'en proceso',
  replied: 'respondió',
  replied_dead_end: 'respondió sin poder avanzar',
  declined: 'el handler no lo tomó',
  no_reply: 'quedó sin respuesta',
  error: 'falló',
  blocked: 'estaba bloqueado',
  fallback_replied: 'respondió el agente de fallback',
}

export function buildRetryContext(last: LastTurn): string {
  return [
    'TURNO ANTERIOR FALLIDO (el usuario está reintentando):',
    `- Mensaje anterior: "${last.text}"`,
    `- Dominio intentado: ${last.domain}${last.reason ? ` (${last.reason})` : ''}`,
    `- Resultado: ${STATUS_LABELS[last.status] ?? last.status}`,
    'Reinterpretá el mensaje actual con el estado real y las herramientas. Si falta un dato, pedilo puntual. No repitas el mismo callejón sin salida.',
  ].join('\n')
}

export function buildFallbackContext(args: {
  text: string
  domain: string
  outcome: HandlerOutcome
}): string {
  return [
    'EL BOT DETERMINÍSTICO NO PUDO RESOLVER ESTE MENSAJE:',
    `- Mensaje: "${args.text}"`,
    `- Dominio intentado: ${args.domain}`,
    `- Resultado: ${args.outcome.handled ? 'respondió sin poder avanzar' : 'no lo tomó o falló'}`,
    'Usá las herramientas y el estado real para resolverlo. Si falta un dato, pedilo puntual. No inventes.',
  ].join('\n')
}

export function assistantOutcomeToStatus(outcome: 'replied' | 'empty' | 'blocked' | 'error'): TurnStatus {
  if (outcome === 'replied') return 'replied'
  if (outcome === 'blocked') return 'blocked'
  if (outcome === 'error') return 'error'
  return 'no_reply'
}

/**
 * Persiste el estado del turno. Tolerante a la columna ausente (migración 056)
 * para no romper el webhook en entornos viejos.
 */
let warnedMissingColumn = false

export async function saveLastTurn(
  db: SupabaseClient,
  conversationId: string,
  turn: LastTurn,
): Promise<void> {
  try {
    const { error } = await db
      .from('conversations')
      .update({ bot_last_turn: turn })
      .eq('id', conversationId)
    if (!error) return
    if (error.message?.includes('bot_last_turn') || error.code === 'PGRST204') {
      if (!warnedMissingColumn) {
        warnedMissingColumn = true
        console.warn('[turn-outcome] columna bot_last_turn ausente — correr migración 056')
      }
      return
    }
    console.warn('[turn-outcome] save failed:', error.message)
  } catch (err) {
    console.warn('[turn-outcome] save error:', err instanceof Error ? err.message : String(err))
  }
}
