import type { UnifiedExtraction } from '@/lib/bot-llm/types'

/**
 * Política de cuándo el asistente debe consultar datos reales (tools) antes de
 * responder. Reemplaza la lista de keywords suelta que vivía en el
 * orquestador: la decisión ahora se apoya en el intent y los campos ya
 * extraídos, y usa un set compacto de pistas factuales solo para el caso
 * `otro` (el cajón de saludos/charla).
 */

/** Preguntas de identidad: nunca disparan tools. */
const IDENTITY_RE =
  /qui[eé]n\s*(sos|eres|es)\b|\bqu[eé]\s*sos\b|\bqui[eé]n\s*soy\b|\bqu[eé]\s*soy\b/

/** Pistas de consulta factual que deben traer datos aunque el intent sea `otro`. */
const CONSULT_HINTS = [
  'cuanto',
  'cuánto',
  'cuantos',
  'cuántos',
  'cuando',
  'cuándo',
  'quien',
  'quién',
  'saldo',
  'debo',
  'debe',
  'deuda',
  'gasto',
  'gasté',
  'gaste',
  'factura',
  'facturas',
  'proveedor',
  'empleado',
  'asistencia',
  'faltó',
  'falto',
  'llegó',
  'llego',
  'pagó',
  'pago',
]

export function isIdentityQuestion(text: string): boolean {
  return IDENTITY_RE.test((text || '').toLowerCase())
}

/**
 * ¿El turno necesita datos reales antes de redactar?
 * - Pregunta de identidad → no.
 * - Intent distinto de `otro` (gasto, multi_expense, factura, asistencia_*) →
 *   sí: son operaciones/consultas que necesitan grounding.
 * - `otro` con campos concretos extraídos o pistas factuales → sí.
 */
export function shouldCallTools(extraction: UnifiedExtraction | null, text: string): boolean {
  if (!extraction) return false
  if (isIdentityQuestion(text)) return false
  if (extraction.intent !== 'otro') return true
  if (
    extraction.monto != null ||
    extraction.proveedor ||
    extraction.empleado ||
    extraction.empleado_gasto ||
    extraction.hora
  ) {
    return true
  }
  const q = (text || '').toLowerCase()
  return CONSULT_HINTS.some((k) => q.includes(k))
}
