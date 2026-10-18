/**
 * Intención de respuesta sí/no del usuario (módulo ÚNICO, fix #4).
 *
 * Tres consumidores con distinta granularidad comparten vocabulario y regla:
 * - `bot/context-command.ts`: comando global de descarte (full-match amplio:
 *   incluye "después", "saltar", "todavía no" → `isDismissCommand`).
 * - `pedidos/summary.ts` (`classifyOrderReply`): respuesta ante pedido
 *   pendiente (token-based → `classifyReply`).
 * - `bot-assistant/pending-confirm.ts`: respuesta corta a confirmación
 *   pendiente (short + `classifyReply`).
 *
 * Regla simétrica (notas-fallos-reales.md, incidente 2): cancelar usa `some`
 * desde siempre; confirmar ahora también — "sí + [verbo que repite la oferta]"
 * confirma ("si conviertela en presupuesto"), mientras que contenido nuevo
 * ("sí pero cambiá…", medidas, cambios) sigue a corrección (`other`).
 */

export type ReplyIntent = 'confirm' | 'cancel' | 'other'

/** Relleno: no aporta significado (se ignora al clasificar). */
export const FILLER_WORDS = new Set([
  'el', 'la', 'los', 'las', 'lo', 'un', 'una', 'unos', 'unas', 'de', 'del', 'en',
  'presupuesto', 'pedido', 'ya', 'entonces', 'che', 'por', 'favor', 'todo', 'gracias',
])

/** Palabras que por sí solas confirman. */
export const CONFIRM_WORDS = new Set([
  'si', 'dale', 'ok', 'oka', 'okey', 'okay', 'confirmo', 'confirmar', 'confirma', 'confirme',
  'confirmado', 'listo', 'perfecto', 'exacto', 'joya', 'bueno', 'va', 'vamos', 'hacelo',
  'hagamoslo', 'metele', 'mandale', 'manda', 'sale', 'correcto', 'aprobado', 'acuerdo',
  'genial', 'buenisimo', 'bien', 'sisi',
])

/** Palabras que por sí solas cancelan/descartan. */
export const CANCEL_WORDS = new Set([
  'no', 'cancelar', 'cancela', 'cancelalo', 'cancelo', 'dejalo', 'deja',
  'olvidalo', 'olvidate', 'anular', 'anula', 'anulalo', 'nada', 'basta',
])

/**
 * Verbos que repiten la oferta (con enclíticos): no aportan contenido nuevo,
 * así que no invalidan una confirmación ("si conviertela en presupuesto").
 * Fija también el fix #5 (conviertela/hacelo/armalo/crealo).
 */
export const RESTATE_VERBS = new Set([
  'convertir', 'convierte', 'converti', 'convertila', 'convertilo', 'conviertela', 'conviertelo',
  'crear', 'crea', 'crealo', 'creala', 'crealos', 'crealas',
  'armar', 'arma', 'armalo', 'armala', 'armalos', 'armarlo',
  'hacer', 'hace', 'hacelo', 'hacela', 'hacelos', 'hacerlo',
  'preparar', 'prepara', 'preparalo', 'preparala',
  'generar', 'genera', 'generalo', 'generala',
  'emitir', 'emite', 'emitilo', 'emitila',
  'cotizar', 'cotiza', 'cotizame', 'cotizalo', 'cotizala',
])

/** Frases que cancelan aunque traigan otra palabra ("mejor no", "no quiero…"). */
export const CANCEL_PHRASE_RE =
  /\bmejor no\b|\bno\s+lo\s+cre(?:es|as)(?:\s*,?\s*(?:era|es|fue)\s+una\s+prueba)?\b|\b(?:era|es|fue)\s+una\s+prueba\b|\bno\s+lo\s+hagas\b|\bno\s+(?:quiero|necesito)\s+(?:un\s+)?presupuesto\b|\bme\s+arrepent[ií]\b/i

/** Frases cortas que confirman aunque sus tokens sean relleno ("de una"). */
export const CONFIRM_PHRASE_RE = /\bde una\b/i

/**
 * Comando global de descarte (full-match): superset para `context-command`.
 * Incluye diferir ("después", "todavía no") y omitir ("saltar", "ninguno")
 * que dentro de un flujo NO cancelan sino que siguen otro camino.
 */
const DISMISS_COMMAND_RE =
  /^(cancelar|cancela|cancelo|olvidalo|olv[ií]dalo|mejor no|despu[eé]s|todav[ií]a no|nada|ninguno|ninguna|saltar|saltear|no\s+lo\s+cre(?:es|as)(?:\s*,?\s*(?:era|es|fue)\s+una\s+prueba)?|(?:era|es|fue)\s+una\s+prueba|no\s+lo\s+hagas|no\s+(?:quiero|necesito)\s+(?:un\s+)?presupuesto|me\s+arrepent[ií])[.!]*$/i

export function normalizeReplyTokens(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/** ¿El mensaje entero es un comando de descarte? (para context-command). */
export function isDismissCommand(text: string): boolean {
  return DISMISS_COMMAND_RE.test((text || '').trim())
}

/**
 * Clasifica la respuesta ante algo pendiente.
 * - cancel: frase de cancelación, o palabra-canceladora sin resto.
 * - confirm: frase corta de confirmación, o palabra-confirmadora cuyo resto
 *   es solo relleno o verbo que repite la oferta.
 * - other: hay contenido nuevo (corrección) o no hay señal.
 */
export function classifyReply(text: string): ReplyIntent {
  if (CANCEL_PHRASE_RE.test(text || '')) return 'cancel'
  if (CONFIRM_PHRASE_RE.test(text || '')) return 'confirm'
  const tokens = normalizeReplyTokens(text)
  const significant = tokens.filter((t) => !FILLER_WORDS.has(t))
  if (significant.length === 0) return 'other'

  if (significant.some((t) => CANCEL_WORDS.has(t))) {
    const rest = significant.filter((t) => !CANCEL_WORDS.has(t))
    if (rest.length === 0) return 'cancel'
  }
  if (significant.some((t) => CONFIRM_WORDS.has(t))) {
    const rest = significant.filter((t) => !CONFIRM_WORDS.has(t) && !RESTATE_VERBS.has(t))
    if (rest.length === 0) return 'confirm'
  }
  return 'other'
}

/** Palabras que, solas, confirman un candidato ("¿es ese cliente?"). */
const YES_WORDS = new Set(['si', 'sisi', 's', 'claro', 'correcto', 'ese', 'esa', 'exacto', 'afirmativo'])

/** Palabras que lo niegan: significan "no es ese / dame otro", NO cancelar. */
const NO_WORDS = new Set(['no', 'nop', 'nope', 'otro', 'otra', 'ninguno', 'ninguna', 'nuevo', 'nueva'])

/**
 * Clasifica la respuesta a "¿es ese?" sobre un candidato de cliente (cuarto
 * detector sí/no, unificado acá). Comparte el normalizador con `classifyReply`
 * pero con OTRA semántica: `no` = "no es ese" (pedir otro), no cancelar.
 */
export function classifyYesNo(text: string): 'yes' | 'no' | null {
  const tokens = normalizeReplyTokens(text)
  if (tokens.length === 0) return null
  const yes = tokens.some((t) => YES_WORDS.has(t))
  const no = tokens.some((t) => NO_WORDS.has(t))
  if (yes && !no) return 'yes'
  if (no && !yes) return 'no'
  return null
}
