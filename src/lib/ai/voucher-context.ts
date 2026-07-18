import type { VoucherData } from './voucher-extraction'
import type { MatchVoucherCandidate, DestinationCandidate } from '../facbal/client'

export interface PendingVoucherItem {
  sourceMessageId: string
  extraction: VoucherData
  candidates: MatchVoucherCandidate[]
  bestDestination: DestinationCandidate | null
  mediaBase64: string
  mediaMimeType: string
}

export interface PendingTextItem {
  text: string
  timestamp: number
}

export interface VoucherContextState {
  pending: PendingVoucherItem[]
  pendingTexts: PendingTextItem[]
}

const PENDING_TEXT_TTL_MS = 60_000

function emptyCtx(): VoucherContextState {
  return { pending: [], pendingTexts: [] }
}

/** Try to migrate an old single-item context to the new array format */
function tryMigrateOldContext(raw: unknown): VoucherContextState {
  if (!raw || typeof raw !== 'object') return emptyCtx()
  const obj = raw as Record<string, unknown>
  if (Array.isArray(obj.pending)) {
    const migrated = obj as unknown as VoucherContextState
    if (!Array.isArray(migrated.pendingTexts)) migrated.pendingTexts = []
    return migrated
  }
  // Detect old format: has pendingCandidates array
  if (Array.isArray(obj.pendingCandidates) && obj.pendingCandidates.length > 0) {
    const item: PendingVoucherItem = {
      sourceMessageId: (obj.sourceMessageId as string) || 'unknown',
      extraction: (obj.pendingExtraction as unknown as VoucherData) || {
        monto: null, fecha: null, referencia: null, banco: null,
        nombre_cliente: null, nombre_origen: null, nombre_destino: null,
        cbu_destino: null, cuit_destino: null,
      },
      candidates: obj.pendingCandidates as MatchVoucherCandidate[],
      bestDestination: null,
      mediaBase64: (obj.mediaBase64 as string) || '',
      mediaMimeType: (obj.mediaMimeType as string) || '',
    }
    return { pending: [item], pendingTexts: [] }
  }
  return emptyCtx()
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
    const raw = data?.voucher_context
    return tryMigrateOldContext(raw)
  } catch {
    return emptyCtx()
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

export async function addPendingVoucher(
  db: import('@supabase/supabase-js').SupabaseClient,
  conversationId: string,
  item: PendingVoucherItem,
): Promise<void> {
  const ctx = await loadVoucherContext(db, conversationId)
  ctx.pending.push(item)
  await saveVoucherContext(db, conversationId, ctx)
}

export async function removePendingVoucher(
  db: import('@supabase/supabase-js').SupabaseClient,
  conversationId: string,
  sourceMessageId: string,
): Promise<void> {
  const ctx = await loadVoucherContext(db, conversationId)
  ctx.pending = ctx.pending.filter((p) => p.sourceMessageId !== sourceMessageId)
  await saveVoucherContext(db, conversationId, ctx)
}

export async function pushPendingText(
  db: import('@supabase/supabase-js').SupabaseClient,
  conversationId: string,
  text: string,
): Promise<void> {
  const ctx = await loadVoucherContext(db, conversationId)
  ctx.pendingTexts.push({ text, timestamp: Date.now() })
  // Keep only last 5 and prune expired
  const cutoff = Date.now() - PENDING_TEXT_TTL_MS
  ctx.pendingTexts = ctx.pendingTexts.filter((t) => t.timestamp > cutoff).slice(-5)
  await saveVoucherContext(db, conversationId, ctx)
}

export async function consumePendingText(
  db: import('@supabase/supabase-js').SupabaseClient,
  conversationId: string,
): Promise<string | null> {
  const ctx = await loadVoucherContext(db, conversationId)
  const cutoff = Date.now() - PENDING_TEXT_TTL_MS
  const valid = ctx.pendingTexts.filter((t) => t.timestamp > cutoff)
  if (valid.length === 0) return null
  const first = valid[0]
  ctx.pendingTexts = ctx.pendingTexts.filter((t) => t !== first)
  await saveVoucherContext(db, conversationId, ctx)
  return first.text
}

export async function clearVoucherContext(
  db: import('@supabase/supabase-js').SupabaseClient,
  conversationId: string,
): Promise<void> {
  return saveVoucherContext(db, conversationId, { pending: [], pendingTexts: [] })
}
