/**
 * Confirmaciones pendientes de la vía del agente (Fase 4).
 *
 * Cuando el gate exige confirmación, la tool guarda la operación acá en vez
 * de ejecutarla. El turno siguiente el usuario confirma o cancela con lenguaje
 * natural; el agente consume la fila y ejecuta con los args GUARDADOS.
 *
 * Solo los helpers de clasificación son puros; el resto es best-effort contra
 * Supabase (nunca lanzan).
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/** TTL de una confirmación pendiente (minutos). */
export const PENDING_TTL_MIN = 15

/** Tools que pueden quedar pendientes (whitelist: nunca otra). */
export const CONFIRMABLE_TOOLS = new Set(['registrar_gasto', 'registrar_asistencia'])

export interface PendingConfirm {
  id: number
  tool: string
  args: Record<string, unknown>
  preview: string | null
}

function normReply(t: string): string {
  return (t || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[?!.,;:()"'\u00a1\u00bf]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const CONFIRM_RES = [
  /^(si|sí|dale|de una|joya|ok|okay|listo|confirmo|confirmado|hacelo|metele|perfecto|exacto|va|bueno|de acuerdo)(\s+(si|sí|dale|de una))?$/,
  /^(si|sí),?\s+(dale|hacelo|metele|confirmo|de una)$/,
]

const CANCEL_RES = [
  /^(no|mejor no|para|para para|cancel[aá]|cancelalo|olvidalo|olvídate|nada|dejalo|dejá|no hagas nada)$/,
  /^(no|mejor no),?\s+(cancel[aá]|nada|dejalo|deja|(no\s+)?lo hagas)$/,
]

/** ¿El mensaje confirma la operación pendiente? (corto y afirmativo). */
export function isConfirmationReply(text: string): boolean {
  const t = normReply(text)
  if (!t || t.length > 40) return false
  return CONFIRM_RES.some((re) => re.test(t))
}

/** ¿El mensaje cancela la operación pendiente? */
export function isCancellationReply(text: string): boolean {
  const t = normReply(text)
  if (!t || t.length > 40) return false
  return CANCEL_RES.some((re) => re.test(t))
}

export async function createPendingConfirm(
  db: SupabaseClient,
  args: {
    account_id: string | null
    conversation_id: string | null
    contact_id: string | null
    tool: string
    toolArgs: Record<string, unknown>
    preview?: string | null
  },
): Promise<number | null> {
  if (!args.conversation_id || !CONFIRMABLE_TOOLS.has(args.tool)) return null
  try {
    const { data, error } = await db
      .from('bot_pending_confirms')
      .insert({
        account_id: args.account_id || null,
        conversation_id: args.conversation_id,
        contact_id: args.contact_id || null,
        tool: args.tool,
        args: args.toolArgs,
        preview: (args.preview || '').slice(0, 500) || null,
      })
      .select('id')
      .maybeSingle()
    if (error) {
      console.warn('[pending-confirm] create failed:', error.message)
      return null
    }
    return (data as { id: number } | null)?.id ?? null
  } catch (err) {
    console.warn('[pending-confirm] create failed:', err instanceof Error ? err.message : String(err))
    return null
  }
}

/** Lee la pendiente vigente sin consumirla (null si no hay o expiró). */
export async function peekFreshPending(
  db: SupabaseClient,
  conversationId: string | null | undefined,
): Promise<PendingConfirm | null> {
  if (!conversationId) return null
  try {
    const { data, error } = await db
      .from('bot_pending_confirms')
      .select('id, tool, args, preview, expires_at')
      .eq('conversation_id', conversationId)
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error || !data) return null
    const row = data as { id: number; tool: string; args: unknown; preview: string | null }
    if (!CONFIRMABLE_TOOLS.has(row.tool)) return null
    return {
      id: row.id,
      tool: row.tool,
      args: (row.args as Record<string, unknown>) ?? {},
      preview: row.preview,
    }
  } catch {
    return null
  }
}

export async function settlePending(
  db: SupabaseClient,
  id: number,
  status: 'confirmed' | 'cancelled' | 'superseded' | 'expired',
): Promise<void> {
  try {
    await db.from('bot_pending_confirms').update({ status }).eq('id', id)
  } catch (err) {
    console.warn('[pending-confirm] settle failed:', err instanceof Error ? err.message : String(err))
  }
}

/**
 * ¿Hay una confirmación reciente (consumida) para esta conversación+tool?
 * Lo usa la tool al recibir `_confirmed: true` para no aceptar el flag sin
 * que exista el pending correspondiente (el modelo no puede saltear el gate
 * inventando el flag: sin fila consumida, se evalúa normal).
 */
export async function hasRecentConfirmation(
  db: SupabaseClient,
  conversationId: string | null | undefined,
  tool: string,
  withinMin = 30,
): Promise<boolean> {
  if (!conversationId) return false
  try {
    const since = new Date(Date.now() - withinMin * 60_000).toISOString()
    const { data, error } = await db
      .from('bot_pending_confirms')
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('tool', tool)
      .eq('status', 'confirmed')
      .gt('created_at', since)
      .limit(1)
      .maybeSingle()
    return !error && !!data
  } catch {
    return false
  }
}
