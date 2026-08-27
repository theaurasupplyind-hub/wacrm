import { callOpenRouter } from '@/lib/ai/openrouter'
import { ASSISTANT_SYSTEM_PROMPT } from './prompts'
import type { UnifiedExtraction } from '@/lib/bot-llm/types'

export async function generateAssistantReply(args: {
  historyText: string
  extraction: UnifiedExtraction | null
  toolResults: Record<string, unknown> | null
  knowledge: string[]
}): Promise<string> {
  const userMessage = `HISTORIAL:\n${args.historyText || '(sin historial)'}\n\nEXTRACCIÓN:\n${JSON.stringify(args.extraction, null, 2)}\n\nDATOS REALES (tools):\n${JSON.stringify(args.toolResults ?? {}, null, 2)}\n\nCONOCIMIENTO:\n${args.knowledge.length > 0 ? args.knowledge.join('\n---\n') : '(sin conocimiento relevante)'}`

  const { text } = await callOpenRouter({
    systemPrompt: ASSISTANT_SYSTEM_PROMPT,
    userMessage,
    temperature: 0.6,
    maxTokens: 600,
  })
  return text
}
