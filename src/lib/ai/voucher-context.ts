import type { VoucherData } from './voucher-extraction'
import type { MatchVoucherCandidate } from '../facbal/client'

export interface VoucherContextState {
  pendingExtraction: VoucherData | null
  pendingCandidates: MatchVoucherCandidate[]
  awaitingConfirmation: boolean
  mediaBase64: string | null
  mediaMimeType: string | null
  sourceMessageId: string | null
}

export async function loadVoucherContext(
  db: import('@supabase/supabase-js').SupabaseClient,
  conversationId: string,
): Promise<VoucherContextState> {
  try {
    const { data } = await db
      .from('conversations')
      .select('voucher_context')
      .eq('id', conversationId)
      .maybeSingle()
    return (data?.voucher_context as VoucherContextState) || {
      pendingExtraction: null,
      pendingCandidates: [],
      awaitingConfirmation: false,
      mediaBase64: null,
      mediaMimeType: null,
      sourceMessageId: null,
    }
  } catch {
    return {
      pendingExtraction: null,
      pendingCandidates: [],
      awaitingConfirmation: false,
      mediaBase64: null,
      mediaMimeType: null,
      sourceMessageId: null,
    }
  }
}

export async function saveVoucherContext(
  db: import('@supabase/supabase-js').SupabaseClient,
  conversationId: string,
  state: VoucherContextState,
): Promise<void> {
  try {
    await db
      .from('conversations')
      .update({ voucher_context: state })
      .eq('id', conversationId)
  } catch (err) {
    console.error('[voucher] save context error:', err)
  }
}

export async function clearVoucherContext(
  db: import('@supabase/supabase-js').SupabaseClient,
  conversationId: string,
): Promise<void> {
  return saveVoucherContext(db, conversationId, {
    pendingExtraction: null,
    pendingCandidates: [],
    awaitingConfirmation: false,
    mediaBase64: null,
    mediaMimeType: null,
    sourceMessageId: null,
  })
}
