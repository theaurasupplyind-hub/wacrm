/**
 * Undo log del bot (Fase 2 del plan agente-conversacional).
 *
 * Persiste cada escritura en `bot_write_log` para poder deshacerla dentro de
 * la ventana de 24h ("te equivocaste" → fix + failure trace en Fase 3).
 * Los fallos de DB nunca rompen la escritura: se loguean y se sigue.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export type UndoEntity = 'gasto' | 'asistencia' | 'factura' | 'pago'

/** Ventana de undo en horas (acordada: 24h). */
export const UNDO_WINDOW_HOURS = 24

export interface UndoHandle {
  entity: UndoEntity
  entity_id?: number | null
  entity_key?: string | null
  summary: string
  /** ISO hasta cuándo se puede deshacer. */
  reversible_until: string
  /** Tool que lo deshace. */
  undo_tool: 'deshacer_ultima_operacion'
}

export interface WriteLogRow {
  id: number
  entity: string
  entity_id: number | null
  entity_key: string | null
  summary: string | null
  undone_at: string | null
  created_at: string
}

export interface RecordWriteArgs {
  account_id: string | null
  conversation_id: string | null
  contact_id: string | null
  entity: UndoEntity
  entity_id?: number | null
  entity_key?: string | null
  summary?: string | null
}

export async function recordWrite(
  db: SupabaseClient,
  w: RecordWriteArgs,
): Promise<UndoHandle | null> {
  if (!w.conversation_id) return null
  try {
    const { error } = await db.from('bot_write_log').insert({
      account_id: w.account_id || null,
      conversation_id: w.conversation_id,
      contact_id: w.contact_id || null,
      entity: w.entity,
      entity_id: w.entity_id ?? null,
      entity_key: w.entity_key ?? null,
      summary: (w.summary || '').slice(0, 500),
    })
    if (error) {
      console.warn('[undo-log] recordWrite failed:', error.message)
      return null
    }
  } catch (err) {
    console.warn('[undo-log] recordWrite failed:', err instanceof Error ? err.message : String(err))
    return null
  }
  return {
    entity: w.entity,
    entity_id: w.entity_id ?? null,
    entity_key: w.entity_key ?? null,
    summary: w.summary || '',
    reversible_until: new Date(Date.now() + UNDO_WINDOW_HOURS * 3600_000).toISOString(),
    undo_tool: 'deshacer_ultima_operacion',
  }
}

/** Última escritura no-deshcha de la conversación dentro de la ventana. */
export async function latestUndoableWrite(
  db: SupabaseClient,
  conversationId: string | null | undefined,
  withinHours = UNDO_WINDOW_HOURS,
): Promise<WriteLogRow | null> {
  if (!conversationId) return null
  try {
    const since = new Date(Date.now() - withinHours * 3600_000).toISOString()
    const { data, error } = await db
      .from('bot_write_log')
      .select('id, entity, entity_id, entity_key, summary, undone_at, created_at')
      .eq('conversation_id', conversationId)
      .is('undone_at', null)
      .gt('created_at', since)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error || !data) return null
    return data as WriteLogRow
  } catch {
    return null
  }
}

export async function markUndone(db: SupabaseClient, id: number): Promise<void> {
  try {
    await db.from('bot_write_log').update({ undone_at: new Date().toISOString() }).eq('id', id)
  } catch (err) {
    console.warn('[undo-log] markUndone failed:', err instanceof Error ? err.message : String(err))
  }
}

export interface UndoAction {
  entity: UndoEntity
  entity_id: number | null
  entity_key: string | null
  describe: string
}

/**
 * Resuelve QUÉ deshacer a partir de una fila (puro, testeable). La ejecución
 * vive en la tool `deshacer_ultima_operacion` del registry.
 */
export function resolveUndoAction(row: WriteLogRow): UndoAction | null {
  switch (row.entity) {
    case 'gasto':
    case 'factura':
    case 'pago':
      if (row.entity_id == null) return null
      return {
        entity: row.entity,
        entity_id: row.entity_id,
        entity_key: null,
        describe: `${row.entity} #${row.entity_id}`,
      }
    case 'asistencia':
      if (!row.entity_key) return null
      return { entity: 'asistencia', entity_id: null, entity_key: row.entity_key, describe: 'asistencia' }
    default:
      return null
  }
}

/** Clave de asistencia para `entity_key` (nombre + fecha). */
export function attendanceKey(empleado: string, fecha: string): string {
  return JSON.stringify({ empleado, fecha })
}

export function parseAttendanceKey(key: string): { empleado: string; fecha: string } | null {
  try {
    const v = JSON.parse(key) as { empleado?: unknown; fecha?: unknown }
    if (typeof v.empleado === 'string' && typeof v.fecha === 'string') {
      return { empleado: v.empleado, fecha: v.fecha }
    }
    return null
  } catch {
    return null
  }
}
