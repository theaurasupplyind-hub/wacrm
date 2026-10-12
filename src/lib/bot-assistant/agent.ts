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
import { historyIncludesCurrent } from './history'
import type { ToolLog } from './tools'
import type { AssistantResult } from './orchestrator'
import type { UnifiedExtraction } from '@/lib/bot-llm/types'

const MAX_AGENT_HISTORY_MESSAGES = 20

export interface AgentRunArgs {
  text: string
  history: { role: string; content: string }[]
  systemPrompt: string
  extraction?: UnifiedExtraction | null
  conversationContext?: string | null
  ctx: ToolContext
  maxIters?: number
  model?: string
}

/**
 * Builds a role-aware transcript for the planner. The webhook persists the
 * inbound message before dispatch, so it may already be the final history
 * item; append it exactly once, enriched with the router's hints and pending
 * state. Keep only recent turns to bound prompt size.
 */
export function buildAgentMessages(
  args: Pick<AgentRunArgs, 'text' | 'history' | 'systemPrompt' | 'extraction' | 'conversationContext'>
): ChatMessage[] {
  const history = args.history.filter(
    (turn): turn is { role: 'user' | 'assistant'; content: string } =>
      (turn.role === 'user' || turn.role === 'assistant') && typeof turn.content === 'string' && !!turn.content.trim()
  )
  const historyWithoutCurrent = historyIncludesCurrent(history, args.text) ? history.slice(0, -1) : history
  const recentHistory = historyWithoutCurrent.slice(-(MAX_AGENT_HISTORY_MESSAGES - 1))
  const messages: ChatMessage[] = [{ role: 'system', content: args.systemPrompt }]

  for (const turn of recentHistory) {
    messages.push({ role: turn.role, content: turn.content })
  }

  const contextParts: string[] = []
  if (args.conversationContext?.trim()) {
    contextParts.push(`ESTADO PENDIENTE DE LA CONVERSACIÓN:\n${args.conversationContext.trim()}`)
  }
  if (args.extraction) {
    const {
      intent,
      confianza,
      extractor_source,
      empleado,
      hora,
      estado,
      monto,
      categoria,
      tipo_gasto,
      saldo_pendiente,
      proveedor,
      empleado_gasto,
      destino,
      metodo_pago,
      multipleExpenses,
      fecha,
      faltan_campos,
      dudoso,
      razon_duda,
    } = args.extraction
    contextParts.push(
      `PISTA DE EXTRACCIÓN (puede equivocarse; el texto original y los resultados de herramientas son la fuente de verdad):\n${JSON.stringify(
        {
          intent,
          confianza,
          extractor_source,
          empleado,
          hora,
          estado,
          monto,
          categoria,
          tipo_gasto,
          saldo_pendiente,
          proveedor,
          empleado_gasto,
          destino,
          metodo_pago,
          multipleExpenses,
          fecha,
          faltan_campos,
          dudoso,
          razon_duda,
        }
      )}`
    )
  }

  messages.push({
    role: 'user',
    content: `${contextParts.length ? `${contextParts.join('\n\n')}\n\n` : ''}MENSAJE ACTUAL:\n${args.text}`,
  })

  return messages
}

export async function runAssistantAgent(args: AgentRunArgs): Promise<AssistantResult> {
  const logs: { step: string; data: unknown }[] = []
  const toolLogs: ToolLog[] = []
  const toolResults: Record<string, unknown> = {}
  const model = args.model || process.env.ASSISTANT_MODEL || undefined

  const messages = buildAgentMessages(args)

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
