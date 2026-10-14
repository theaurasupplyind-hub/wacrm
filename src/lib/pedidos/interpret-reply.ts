/**
 * Entendimiento de respuestas ante pedido pendiente (anti-keywords).
 *
 * `classifyReply` (listas) resuelve lo obvio sin costo. Solo cuando da
 * `'other'`, se consulta al LLM con el contexto de lo pendiente: así
 * "si conviertela en presupuesto" o "al final mejor no" se entienden por
 * significado, no por coincidir con una lista.
 *
 * Ante cualquier fallo del LLM se devuelve `'other'` = comportamiento actual.
 * Sin side effects: solo clasifica.
 */
import { callOpenRouter } from '@/lib/ai/openrouter'
import { classifyReply, type ReplyIntent } from '@/lib/bot-llm/reply-intent'

export interface PendingQuoteSummary {
  /** Qué está esperando el bot (ej: "aprobación de cotización $479.000"). */
  waitingFor: string
  /** Ítems en juego, si aplica. */
  itemsText?: string | null
}

const INTERPRET_PROMPT = `Sos el juez de una respuesta ante un presupuesto pendiente en un taller de marcos. Devolvé EXCLUSIVAMENTE un JSON: {"decision": "confirm" | "cancel" | "other"}.
- "confirm": el usuario acepta o aprueba, aunque agregue palabras que repiten lo ofrecido ("sí conviertela en presupuesto", "dale hacelo", "ok de una").
- "cancel": rechaza o anula, aunque sea indirecto ("al final mejor no", "mejor dejalo", "era una prueba").
- "other": corrige o cambia algo (medidas, cantidades, "pero", "mejor X", preguntas) o no se entiende.
DEVOLVÉ SOLO EL JSON.`

export async function interpretOrderReply(
  text: string,
  pending: PendingQuoteSummary,
): Promise<{ decision: ReplyIntent }> {
  // Fast path determinístico: lo obvio no paga LLM.
  const fast = classifyReply(text)
  if (fast !== 'other') return { decision: fast }

  try {
    const itemsLine = pending.itemsText ? `\nÍtems: ${pending.itemsText}` : ''
    const res = await callOpenRouter({
      systemPrompt: INTERPRET_PROMPT,
      userMessage: `Pendiente: ${pending.waitingFor}.${itemsLine}\nMensaje del usuario: "${text}"`,
      jsonMode: true,
      temperature: 0,
      maxTokens: 150,
      model: process.env.EXTRACTOR_MODEL || undefined,
    })
    const block = res.text.match(/\{[\s\S]*\}/)
    const parsed = JSON.parse(block ? block[0] : res.text) as { decision?: unknown }
    if (parsed.decision === 'confirm' || parsed.decision === 'cancel' || parsed.decision === 'other') {
      return { decision: parsed.decision }
    }
    return { decision: 'other' }
  } catch (err) {
    console.error('[interpret-reply] LLM falló, cae a other:', err instanceof Error ? err.message : String(err))
    return { decision: 'other' }
  }
}
