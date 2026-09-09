import type { SupabaseClient } from '@supabase/supabase-js'
import type { Ambiguity } from './ambiguity'

/**
 * Aclaración pendiente (bot conversacional): cuando el intent es ambiguo se
 * pregunta con botones y se guarda aquí para resolver la respuesta.
 * TTL corto: una respuesta tardía recibe mensaje de expirado, nunca se
 * procesa a ciegas. Máximo 1 pendiente por conversación.
 */

export const CLARIFY_TTL_MS = 5 * 60 * 1000

export interface ClarifyContextState {
  question: string
  options: Ambiguity['options']
  /** intent original para auditoría */
  originalIntent: string
  /** campos de la extracción original para fusionar al resolver */
  origExtra?: {
    proveedor: string | null
    monto: number | null
    metodo_pago: string | null
    empleado: string | null
    hora: string | null
    categoria: string | null
    fecha: string | null
  } | null
  updatedAt?: number | null
  /** la respuesta no matcheó una vez (para re-preguntar con guía) */
  renotified?: boolean
}

export async function loadClarifyContext(
  db: SupabaseClient,
  conversationId: string,
): Promise<{ state: ClarifyContextState; expired: boolean } | null> {
  try {
    const { data } = await db
      .from('conversations')
      .select('clarify_context')
      .eq('id', conversationId)
      .maybeSingle()
    const ctx = data?.clarify_context as ClarifyContextState | null
    if (!ctx || !Array.isArray(ctx.options) || ctx.options.length === 0) return null
    if (typeof ctx.updatedAt === 'number' && Date.now() - ctx.updatedAt > CLARIFY_TTL_MS) {
      return { state: ctx, expired: true }
    }
    return { state: ctx, expired: false }
  } catch {
    return null
  }
}

export async function saveClarifyContext(
  db: SupabaseClient,
  conversationId: string,
  state: ClarifyContextState,
) {
  try {
    await db
      .from('conversations')
      .update({ clarify_context: { ...state, updatedAt: Date.now() } })
      .eq('id', conversationId)
  } catch (err) {
    console.error('[clarify] save context error:', err)
  }
}

export async function clearClarifyContext(
  db: SupabaseClient,
  conversationId: string,
) {
  try {
    await db
      .from('conversations')
      .update({ clarify_context: null })
      .eq('id', conversationId)
  } catch (err) {
    console.error('[clarify] clear context error:', err)
  }
}
