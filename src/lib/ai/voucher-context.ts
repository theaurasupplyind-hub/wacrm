import type { VoucherData } from './voucher-extraction'
import type { MatchVoucherCandidate, DestinationCandidate } from '../facbal/client'

export interface PendingVoucherItem {
  sourceMessageId: string
  extraction: VoucherData
  candidates: MatchVoucherCandidate[]
  bestDestination: DestinationCandidate | null
  mediaBase64: string
  mediaMimeType: string
  multiInvoice?: boolean
  /** Timestamp (ms) de creación; usado para expirar pendientes abandonados. */
  createdAt?: number
}

export interface PendingTextItem {
  text: string
  timestamp: number
}

/**
 * "No encontré facturas para Martu": se guarda el pago original (método,
 * fecha, destino) para que el próximo mensaje pueda ser el monto o el nombre
 * completo del cliente. TTL corto: una respuesta tardía no debe secuestrar
 * mensajes nuevos.
 */
export interface AwaitingClientMatch {
  metodoPago: 'Efectivo' | 'Transferencia'
  monto: number | null
  fecha: string | null
  destName: string | null
  /** Nombre que se intentó y no matcheó (ej. "Martu"). */
  attemptedName: string | null
  createdAt?: number | null
}

export interface VoucherContextState {
  pending: PendingVoucherItem[]
  pendingTexts: PendingTextItem[]
}

const PENDING_TEXT_TTL_MS = 60_000

/**
 * Un comprobante pendiente sin resolver por más de este tiempo se considera
 * abandonado y se descarta (evita que un pending viejo "secuestre" textos).
 */
export const VOUCHER_PENDING_TTL_MS = 30 * 60 * 1000

/** TTL del follow-up "¿me pasás el monto o el nombre completo?". */
export const VOUCHER_AWAITING_MATCH_TTL_MS = 5 * 60 * 1000

export function isAwaitingMatchFresh(
  state: AwaitingClientMatch | null | undefined,
  now = Date.now(),
): boolean {
  if (!state || typeof state.createdAt !== 'number') return false
  return now - state.createdAt <= VOUCHER_AWAITING_MATCH_TTL_MS
}


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
    const ctx = tryMigrateOldContext(raw)
    // Expira pendientes abandonados (los creados antes de esta migración no
    // tienen createdAt: se conservan para no perder nada).
    const now = Date.now()
    const fresh = ctx.pending.filter(
      (p) => p.createdAt == null || now - p.createdAt <= VOUCHER_PENDING_TTL_MS,
    )
    if (fresh.length !== ctx.pending.length) {
      console.log('[voucher] pruning %d expired pending(s)', ctx.pending.length - fresh.length)
      ctx.pending = fresh
    }
    return ctx
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
    // Sólo pending/pendingTexts: `voucher_awaiting_match` vive en su propia
    // columna y no debe pisarse con un read-modify-write del contexto.
    await db
      .from('conversations')
      .update({
        voucher_context: {
          pending: state.pending,
          pendingTexts: state.pendingTexts,
        },
      })
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
  try {
    item.createdAt = item.createdAt ?? Date.now()
    await db.rpc('voucher_append_pending', {
      conv_id: conversationId,
      new_item: item as unknown as Record<string, unknown>,
    })
  } catch (err) {
    console.error('[voucher] add pending error:', err)
  }
}

export async function removePendingVoucher(
  db: import('@supabase/supabase-js').SupabaseClient,
  conversationId: string,
  sourceMessageId: string,
): Promise<void> {
  try {
    await db.rpc('voucher_remove_pending', {
      conv_id: conversationId,
      msg_id: sourceMessageId,
    })
  } catch (err) {
    console.error('[voucher] remove pending error:', err)
  }
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

/**
 * Carga el follow-up "¿me pasás el monto o el nombre completo?" de la columna
 * `voucher_awaiting_match`. Si la migración 055 no corrió (o el estado venció)
 * devuelve null sin romper el webhook.
 */
export async function loadAwaitingMatch(
  db: import('@supabase/supabase-js').SupabaseClient,
  conversationId: string,
): Promise<AwaitingClientMatch | null> {
  try {
    const { data } = await db
      .from('conversations')
      .select('voucher_awaiting_match')
      .eq('id', conversationId)
      .maybeSingle()
    const raw = data?.voucher_awaiting_match as AwaitingClientMatch | null
    if (!isAwaitingMatchFresh(raw)) return null
    return raw
  } catch {
    return null
  }
}

export async function saveAwaitingMatch(
  db: import('@supabase/supabase-js').SupabaseClient,
  conversationId: string,
  state: Omit<AwaitingClientMatch, 'createdAt'>,
): Promise<void> {
  try {
    await db
      .from('conversations')
      .update({
        voucher_awaiting_match: {
          ...state,
          createdAt: Date.now(),
        },
      })
      .eq('id', conversationId)
  } catch (err) {
    console.error('[voucher] save awaiting match error:', err)
  }
}

export async function clearAwaitingMatch(
  db: import('@supabase/supabase-js').SupabaseClient,
  conversationId: string,
): Promise<void> {
  try {
    await db
      .from('conversations')
      .update({ voucher_awaiting_match: null })
      .eq('id', conversationId)
  } catch (err) {
    console.error('[voucher] clear awaiting match error:', err)
  }
}
