/**
 * Persistencia del failure trace (Fase 3 del plan agente-conversacional).
 *
 * - `logFailureSignal`: inserta la señal (sombra, best-effort, nunca lanza).
 * - `resolveLatestPending`: marca la última señal pendiente de la conversación
 *   como resuelta (la llaman las tools de corrección del registry).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { FailureReporter } from './failure-detect'

export type FailureResolution = 'deshecho' | 'editado' | 'confirmado_igual' | 'sin_accion'

export interface LogFailureSignalArgs {
  account_id: string | null
  conversation_id: string | null
  contact_id: string | null
  message_id?: string | null
  signal_text: string
  reporter: FailureReporter
  write_log_id?: number | null
  intent?: string | null
  confianza?: string | null
}

export async function logFailureSignal(
  db: SupabaseClient,
  args: LogFailureSignalArgs,
): Promise<number | null> {
  if (!args.conversation_id) return null
  try {
    const { data, error } = await db
      .from('bot_failure_traces')
      .insert({
        account_id: args.account_id || null,
        conversation_id: args.conversation_id,
        contact_id: args.contact_id || null,
        message_id: args.message_id || null,
        signal_text: args.signal_text.slice(0, 500),
        reporter: args.reporter,
        write_log_id: args.write_log_id ?? null,
        intent: args.intent || null,
        confianza: args.confianza || null,
      })
      .select('id')
      .maybeSingle()
    if (error) {
      console.warn('[failure-trace] log failed:', error.message)
      return null
    }
    return (data as { id: number } | null)?.id ?? null
  } catch (err) {
    console.warn('[failure-trace] log failed:', err instanceof Error ? err.message : String(err))
    return null
  }
}

export async function resolveLatestPending(
  db: SupabaseClient,
  conversationId: string | null | undefined,
  resolution: FailureResolution,
  detail?: string | null,
): Promise<boolean> {
  if (!conversationId) return false
  try {
    const { data, error } = await db
      .from('bot_failure_traces')
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('resolution', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error || !data) return false
    const { error: upErr } = await db
      .from('bot_failure_traces')
      .update({
        resolution,
        resolution_detail: (detail || '').slice(0, 500) || null,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', (data as { id: number }).id)
    return !upErr
  } catch {
    return false
  }
}
