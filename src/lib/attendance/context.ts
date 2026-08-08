import type { SupabaseClient } from '@supabase/supabase-js'
import type { AttendanceStatusType } from './parse-attendance'

export interface AttendanceContextState {
  pendingEmployee?: string | null
  pendingType?: AttendanceStatusType | null
  pendingDate?: string | null
  pendingTime?: string | null
  awaitingCorrection?: boolean
  existingEmployeeId?: number | null
  existingStatus?: string | null
}

export async function loadAttendanceContext(
  db: SupabaseClient,
  conversationId: string,
): Promise<AttendanceContextState> {
  try {
    const { data } = await db
      .from('conversations')
      .select('attendance_context')
      .eq('id', conversationId)
      .maybeSingle()
    return (data?.attendance_context as AttendanceContextState) || {}
  } catch {
    return {}
  }
}

export async function saveAttendanceContext(
  db: SupabaseClient,
  conversationId: string,
  state: AttendanceContextState,
) {
  try {
    await db
      .from('conversations')
      .update({ attendance_context: state })
      .eq('id', conversationId)
  } catch (err) {
    console.error('[attendance] save context error:', err)
  }
}

export async function clearAttendanceContext(
  db: SupabaseClient,
  conversationId: string,
) {
  return saveAttendanceContext(db, conversationId, {})
}
