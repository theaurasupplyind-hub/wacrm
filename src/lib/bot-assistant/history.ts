export interface TurnInput {
  role: string
  content: string
}

export function buildHistoryText(turns: TurnInput[]): string {
  return turns.slice(-10).map((t) => `${t.role}: ${t.content}`).join('\n')
}

/**
 * ¿El último turno del historial ya es el mensaje entrante?
 *
 * En producción `buildConversationContext` lee de la DB DESPUÉS de insertar el
 * mensaje del cliente, así que el texto actual ya viene en `turns`. En Beta el
 * historial lo provee el cliente y puede no incluirlo. Evita duplicar el
 * mensaje actual en el prompt (que sesgaba al modelo).
 */
export function historyIncludesCurrent(turns: TurnInput[], text: string): boolean {
  const last = turns[turns.length - 1]
  return !!last && last.role === 'user' && last.content.trim() === text.trim()
}

/**
 * Construye el historial textual para el responder, agregando el mensaje
 * actual SOLO si el historial no lo trae ya.
 */
export function buildHistoryTextWithCurrent(turns: TurnInput[], text: string): string {
  const base = buildHistoryText(turns)
  if (historyIncludesCurrent(turns, text)) return base
  const line = `user: ${text}`
  return base ? `${base}\n${line}` : line
}
