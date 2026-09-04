export interface PastedConversationResult {
  customerText: string
  speaker: string
}

/**
 * Detecta bloque pegado de WhatsApp export ambos lados.
 * Formato por línea: [HH:MM[, dd/M/yyyy]] Nombre: texto
 * Requiere >=2 líneas que matcheen. Extrae solo líneas del cliente (speaker !== 'Vos').
 */
export function detectPastedConversation(text: string): PastedConversationResult | null {
  if (!text || !text.includes('[') || !text.includes(':')) return null
  const lines = text.split('\n')
  const regex = /^\s*\[(\d{1,2}:\d{2}(?:[^\]]*))\]\s*([^:]+):\s*(.+)$/
  const matched: { speaker: string; content: string }[] = []

  for (const line of lines) {
    const m = line.match(regex)
    if (m) {
      const speaker = m[2].trim()
      const content = m[3].trim()
      if (speaker && content) matched.push({ speaker, content })
    }
  }

  if (matched.length < 2) return null

  const clientLines = matched.filter((m) => m.speaker.toLowerCase() !== 'vos')
  if (clientLines.length === 0) return null

  const customerText = clientLines.map((m) => m.content).join('\n')
  const speaker = clientLines[clientLines.length - 1].speaker

  return { customerText, speaker }
}
