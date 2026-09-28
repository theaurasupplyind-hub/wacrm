import type { SupabaseClient } from '@supabase/supabase-js'
import type { Ambiguity } from './ambiguity'
import type { BotIntent, UnifiedExtraction } from './types'

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
    destino: string | null
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

/**
 * Construye la extracción que se despacha tras responder una aclaración.
 *
 * El extractor no corre en replies interactivos (tap de botón), así que el
 * intent elegido y los campos del mensaje original (`origExtra`) se fusionan
 * acá. `origExtra` gana sobre la extracción de la respuesta (que suele ser
 * ruido: "Me pagó (cobro)"); ambos caen a los defaults cuando no aportan.
 */
export function resolveClarifyExtraction(
  current: UnifiedExtraction | null,
  orig: ClarifyContextState['origExtra'] | null | undefined,
  chosenIntent: BotIntent,
  rawText: string,
): UnifiedExtraction {
  const base: UnifiedExtraction = {
    intent: chosenIntent,
    confianza: 'alta',
    extractor_source: 'fallback',
    empleado: null,
    hora: null,
    estado: null,
    monto: null,
    categoria: null,
    tipo_gasto: null,
    saldo_pendiente: null,
    proveedor: null,
    empleado_gasto: null,
    destino: null,
    metodo_pago: null,
    fecha: null,
    faltan_campos: [],
    dudoso: false,
    razon_duda: null,
    raw: rawText,
  }

  if (current) {
    base.multipleExpenses = current.multipleExpenses
    base.tipo_gasto = current.tipo_gasto
    base.saldo_pendiente = current.saldo_pendiente
    base.empleado_gasto = current.empleado_gasto
    base.estado = current.estado
    base.proveedor = current.proveedor
    base.monto = current.monto
    base.metodo_pago = current.metodo_pago
    base.destino = current.destino
    base.empleado = current.empleado
    base.hora = current.hora
    base.categoria = current.categoria
    base.fecha = current.fecha
  }

  if (orig) {
    base.proveedor = orig.proveedor ?? base.proveedor
    base.monto = orig.monto ?? base.monto
    base.metodo_pago = orig.metodo_pago ?? base.metodo_pago
    base.destino = orig.destino ?? base.destino
    base.empleado = orig.empleado ?? base.empleado
    base.hora = orig.hora ?? base.hora
    base.categoria = orig.categoria ?? base.categoria
    base.fecha = orig.fecha ?? base.fecha
  }

  return base
}
