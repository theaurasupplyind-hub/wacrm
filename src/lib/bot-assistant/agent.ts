/**
 * Loop de agente con tool-calling para el asistente.
 *
 * Alternativa a `runAssistant` (orchestrator) cuando `ASSISTANT_TOOLS_ENABLED`
 * está activo: el modelo elige tools (consultar facturas, registrar gasto,
 * etc.) y el runtime las ejecuta contra los handlers reales. Cap de
 * iteraciones para evitar loops; sin tools definidas cae a texto.
 */

import { callOpenRouterChat, type ChatMessage } from '@/lib/ai/openrouter'
import { findAgentTool, agentToolDefinitions, type ToolContext } from './tool-registry'
import { buildHistoryText } from './history'
import type { ToolLog } from './tools'
import type { AssistantResult } from './orchestrator'
import type { UnifiedExtraction } from '@/lib/bot-llm/types'

export interface AgentRunArgs {
  text: string
  history: { role: string; content: string }[]
  systemPrompt: string
  extraction?: UnifiedExtraction | null
  ctx: ToolContext
  maxIters?: number
  model?: string
}

export async function runAssistantAgent(args: AgentRunArgs): Promise<AssistantResult> {
  const logs: { step: string; data: unknown }[] = []
  const toolLogs: ToolLog[] = []
  const toolResults: Record<string, unknown> = {}
  const model = args.model || process.env.ASSISTANT_MODEL || undefined

  const historyText = buildHistoryText(args.history)
  const messages: ChatMessage[] = [
    { role: 'system', content: args.systemPrompt },
    {
      role: 'user',
      content: `${historyText ? `HISTORIAL:\n${historyText}\n\n` : ''}MENSAJE: ${args.text}`,
    },
  ]

  const tools = agentToolDefinitions()
  const maxIters = args.maxIters ?? 4
  let reply = ''

  for (let i = 0; i < maxIters; i++) {
    const res = await callOpenRouterChat({ messages, tools, model })
    logs.push({
      step: 'agent_step',
      data: { iter: i, toolCalls: res.toolCalls.map((c) => c.function.name), finish: res.finishReason },
    })

    if (res.toolCalls.length === 0) {
      reply = res.text ?? ''
      break
    }

    messages.push({ role: 'assistant', content: res.text, tool_calls: res.toolCalls })

    for (const call of res.toolCalls) {
      const tool = findAgentTool(call.function.name)
      let toolArgs: Record<string, unknown> = {}
      try {
        toolArgs = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>
      } catch {
        toolArgs = {}
      }

      if (!tool) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: `Tool desconocida: ${call.function.name}` }),
        })
        continue
      }

      const t0 = Date.now()
      try {
        const out = await tool.execute(toolArgs, args.ctx)
        toolResults[tool.name] = out.data
        const count = Array.isArray(out.data)
          ? out.data.length
          : out.data && typeof out.data === 'object'
            ? 1
            : 0
        toolLogs.push({ tool: tool.name, duration_ms: Date.now() - t0, resultCount: count })
        logs.push({ step: `agent_tool_${tool.name}`, data: { args: toolArgs, summary: out.summary } })
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(out.data ?? null).slice(0, 4000),
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        toolLogs.push({ tool: tool.name, duration_ms: Date.now() - t0, error: msg })
        logs.push({ step: `agent_tool_${tool.name}_error`, data: { error: msg } })
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: msg }),
        })
      }
    }

    if (i === maxIters - 1) {
      // Última iteración: forzamos respuesta de texto sin más tools.
      const final = await callOpenRouterChat({ messages, toolChoice: 'none', model })
      reply = final.text ?? ''
    }
  }

  if (!reply.trim()) {
    reply = 'Che, no pude procesar tu mensaje. ¿Me lo repetís?'
  }

  logs.push({ step: 'agent_response', data: { reply_preview: reply.slice(0, 300) } })

  return {
    reply,
    extraction: args.extraction ?? null,
    toolResults: Object.keys(toolResults).length > 0 ? toolResults : null,
    knowledge: [],
    logs,
    toolLogs,
  }
}
