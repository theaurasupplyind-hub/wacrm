import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExpenseContextState } from './types'

export async function loadExpenseContext(
  db: SupabaseClient,
  conversationId: string,
): Promise<ExpenseContextState> {
  try {
    const { data } = await db
      .from('conversations')
      .select('expense_context')
      .eq('id', conversationId)
      .maybeSingle()
    return (data?.expense_context as ExpenseContextState) || {}
  } catch {
    return {}
  }
}

export async function saveExpenseContext(
  db: SupabaseClient,
  conversationId: string,
  state: ExpenseContextState,
) {
  try {
    await db
      .from('conversations')
      .update({ expense_context: state })
      .eq('id', conversationId)
  } catch (err) {
    console.error('[expense] save context error:', err)
  }
}

export async function clearExpenseContext(
  db: SupabaseClient,
  conversationId: string,
) {
  return saveExpenseContext(db, conversationId, {})
}
