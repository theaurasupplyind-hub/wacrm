import { callOpenRouter } from '@/lib/ai/openrouter'
import { ASSISTANT_SYSTEM_PROMPT } from './prompts'
import { compactToolResults } from './evidence'
import type { UnifiedExtraction } from '@/lib/bot-llm/types'

export async function generateAssistantReply(args: {
  historyText: string
  extraction: UnifiedExtraction | null
  toolResults: Record<string, unknown> | null
  knowledge: string[]
}): Promise<string> {
  const evidence = compactToolResults(args.toolResults)
  const faltan = args.extraction?.faltan_campos ?? []
  const faltanLine =
    faltan.length > 0
      ? `\n\nCAMPOS FALTANTES (preguntá SOLO por el primero, puntual): ${faltan.join(', ')}`
      : ''
  const userMessage = `HISTORIAL:\n${args.historyText || '(sin historial)'}\n\nEXTRACCIÓN:\n${JSON.stringify(args.extraction, null, 2)}\n\nDATOS REALES (tools):\n${JSON.stringify(evidence ?? {}, null, 2)}${faltanLine}\n\nCONOCIMIENTO:\n${args.knowledge.length > 0 ? args.knowledge.join('\n---\n') : '(sin conocimiento relevante)'}`

  // Reintento único ante respuesta vacía del modelo (flakiness conocida de
  // Gemini; el extractor/tools ya corrieron y salieron bien, sería una lástima
  // tirar el turno). Si el segundo intento también viene vacío, lanza y el
  // caller responde el fallback.
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { text } = await callOpenRouter({
        systemPrompt: ASSISTANT_SYSTEM_PROMPT,
        userMessage,
        temperature: 0.2,
        maxTokens: 600,
        model: process.env.ASSISTANT_MODEL || undefined,
      })
      return text
    } catch (err) {
      lastErr = err
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes('respuesta vacía') || attempt > 0) throw err
      console.warn('[responder] respuesta vacía, reintento 2/2')
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}
