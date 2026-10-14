/**
 * Detector de señales de corrección (Fase 3 del plan agente-conversacional).
 *
 * Módulo PURO (sin I/O): detecta si un mensaje del usuario es feedback sobre
 * algo que el bot hizo mal ("te equivocaste") o un error propio admitido
 * ("me equivoqué"). Ambos se tracean; se etiquetan distinto porque solo el
 * primero es fallo del bot.
 *
 * Conservador a propósito: ante la duda no dispara (los falsos positivos
 * ensucian el reporte semanal). La lista se calibra con el reporte.
 */

export type FailureReporter = 'bot_error' | 'user_error'

export interface FailureSignal {
  reporter: FailureReporter
  /** Fragmento que disparó (para auditoría). */
  matched: string
}

/** El usuario dice que EL BOT se equivocó. */
const BOT_ERROR_RES = [
  /te equivocaste/i,
  /te confundiste/i,
  /est[aá] mal (eso|esto|lo que|como)/i,
  /\bno era (eso|esto|as[ií])\b/i,
  /\beso no era\b/i,
  /\best[aá] incorrecto/i,
  /\bmal ah[ií]\b/i,
  /\ble pifiaste/i,
  /\ble erraste/i,
  /\bnada que ver\b/i,
  /cancel[aá] (eso|esto|lo|la|el gasto|el presupuesto)/i,
  /\bdeshac[eé] (eso|esto|lo)\b/i,
  /\bborral[oa]?\b/i,
]

/** El usuario admite que se equivocó ÉL (se corrige igual, otra etiqueta). */
const USER_ERROR_RES = [
  /\bme equivoqu[eé]\b/i,
  /\bperd[oó]n,? (me|yo)/i,
  /\bfue error m[ií]o\b/i,
  /\bme confund[ií] yo\b/i,
  /\bquise decir\b/i,
  /\bme corrijo\b/i,
]

export function detectFailureSignal(text: string): FailureSignal | null {
  const t = (text || '').trim()
  if (!t || t.length > 300) return null
  for (const re of USER_ERROR_RES) {
    const m = t.match(re)
    if (m) return { reporter: 'user_error', matched: m[0] }
  }
  for (const re of BOT_ERROR_RES) {
    const m = t.match(re)
    if (m) return { reporter: 'bot_error', matched: m[0] }
  }
  return null
}
