/**
 * Fuente única de verdad para la calibración de confianza del bot.
 *
 * Antes los umbrales vivían dispersos (classify-jev, router, tools) y podían
 * desincronizarse. Todo módulo que necesite mapear un score numérico a
 * `Confidence` o comparar contra un umbral debe importar de acá.
 */

import type { Confidence } from './types'

/** Score calibrado (0–1) de Jev a partir del cual puede sobrescribir al LLM. */
export const JEV_OVERRIDE_MIN_CONFIDENCE = 0.6

/** `answersPending` mínimo para que Jev rutee una respuesta a un pendiente. */
export const JEV_ANSWERS_PENDING_MIN = 0.7

/** `supersedes` mínimo para que Jev libere un pendiente abandonado. */
export const JEV_SUPERSEDES_MIN = 0.7

/** Umbrales de `confidence` calibrada → `Confidence` discreta. */
export const CONFIDENCE_ALTA_MIN = 0.75
export const CONFIDENCE_MEDIA_MIN = 0.45

/** Mapea un score calibrado (0–1) a la `Confidence` de 3 niveles. */
export function confidenceToConfianza(confidence: number): Confidence {
  if (confidence >= CONFIDENCE_ALTA_MIN) return 'alta'
  if (confidence >= CONFIDENCE_MEDIA_MIN) return 'media'
  return 'baja'
}

/** Confianza `alta` (intent firme). */
export function isHighConfidence(confidence: Confidence | undefined | null): boolean {
  return confidence === 'alta'
}

/**
 * Intent "fuerte": alta o media. Un mensaje con esta confianza no debe quedar
 * atrapado por un pendiente abandonado de otro dominio.
 */
export function isStrongConfidence(confidence: Confidence | undefined | null): boolean {
  return confidence === 'alta' || confidence === 'media'
}
