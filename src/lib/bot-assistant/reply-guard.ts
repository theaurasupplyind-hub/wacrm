/**
 * Guard de salida del orquestador (G3, Fase 7).
 *
 * El asistente LLM NO debe emitir el estado de creación de un presupuesto: eso
 * lo produce SOLO el flujo de pedidos con datos reales (itemizado, cliente y
 * confirmación determinísticos). Si el modelo "imita" ese formato, inventa
 * estado (cliente, nº de presupuesto) — exactamente el incidente del 15/10
 * ("Cliente nuevo: Pachecho … ¿Confirmás?").
 *
 * Se aplica a la respuesta del asistente ANTES de enviarla. No bloquea el
 * preview legítimo de `cotizar_pedido` ("Cotización estimada:") ni el preview de
 * confirmación de escrituras ("Revisá antes de guardar … ¿Confirmás?").
 */

const FORBIDDEN_REPLY_RE =
  /voy a armar (?:este|el) presupuesto|cliente nuevo\s*:|\bpresupuesto\s+p-?\d/i

export const FORBIDDEN_REPLY_FALLBACK =
  'Para el presupuesto seguimos por acá: te muestro la cotización y lo confirmás vos. ¿Lo armamos?'

export function guardAssistantReply(text: string): { text: string; blocked: boolean } {
  const t = (text || '').trim()
  if (FORBIDDEN_REPLY_RE.test(t)) return { text: FORBIDDEN_REPLY_FALLBACK, blocked: true }
  return { text, blocked: false }
}
