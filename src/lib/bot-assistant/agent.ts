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
import { deriveMatchInfo } from './effect-gate'
import {
  peekFreshPending,
  settlePending,
  isConfirmationReply,
  isCancellationReply,
} from './pending-confirm'
import { fuzzyMatchExpense } from '@/lib/expenses/fuzzy-match'
import type { ParsedExpense } from '@/lib/expenses/types'
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
  /**
   * Contexto del turno anterior fallido (fallback/reintento). Se presenta
   * aparte del estado pendiente para que el modelo entienda la reformulación.
   */
  retryContext?: string | null
  /** false = solo tools de lectura (fallback con ASSISTANT_FALLBACK_WRITES=false). */
  allowWrites?: boolean
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
  args: Pick<
    AgentRunArgs,
    'text' | 'history' | 'systemPrompt' | 'extraction' | 'conversationContext' | 'retryContext'
  >
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
  if (args.retryContext?.trim()) {
    contextParts.push(args.retryContext.trim())
  }
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

/**
 * Resuelve una confirmación pendiente del turno anterior (Fase 4).
 * Devuelve reply lista (corta el loop) o null para seguir normal.
 * Solo ejecuta tools de la whitelist de confirmables con los args GUARDADOS.
 */
async function maybeHandlePendingConfirm(args: {
  text: string
  toolCtx: ToolContext
  extraction: UnifiedExtraction | null
}): Promise<{
  reply: string
  toolResults: Record<string, unknown>
  logs: { step: string; data: unknown }[]
  toolLogs: ToolLog[]
} | null> {
  const pending = await peekFreshPending(args.toolCtx.db, args.toolCtx.conversationId)
  if (!pending) return null

  if (isCancellationReply(args.text)) {
    await settlePending(args.toolCtx.db, pending.id, 'cancelled')
    return {
      reply: 'Listo, no guardé nada.',
      toolResults: {},
      logs: [{ step: 'pending_cancelled', data: { pendingId: pending.id } }],
      toolLogs: [],
    }
  }

  if (isConfirmationReply(args.text)) {
    const tool = findAgentTool(pending.tool)
    if (!tool) {
      await settlePending(args.toolCtx.db, pending.id, 'expired')
      return null
    }
    await settlePending(args.toolCtx.db, pending.id, 'confirmed')
    const t0 = Date.now()
    try {
      const out = await tool.execute({ ...pending.args, _confirmed: true }, args.toolCtx)
      return {
        reply: out.summary || 'Listo.',
        toolResults: { [tool.name]: out.data },
        logs: [{ step: 'pending_confirmed', data: { pendingId: pending.id, tool: tool.name } }],
        toolLogs: [{ tool: tool.name, duration_ms: Date.now() - t0 }],
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        reply: 'No pude confirmarlo. ¿Me lo repetís?',
        toolResults: {},
        logs: [{ step: 'pending_confirm_error', data: { error: msg } }],
        toolLogs: [{ tool: pending.tool, duration_ms: Date.now() - t0, error: msg }],
      }
    }
  }

  // Otro tema: la pendiente se supera y se sigue el loop normal.
  await settlePending(args.toolCtx.db, pending.id, 'superseded')
  return null
}

export async function runAssistantAgent(args: AgentRunArgs): Promise<AssistantResult> {
  const logs: { step: string; data: unknown }[] = []
  const toolLogs: ToolLog[] = []
  const toolResults: Record<string, unknown> = {}
  const model = args.model || process.env.ASSISTANT_MODEL || undefined
  const allowWrites = args.allowWrites !== false

  const messages = buildAgentMessages(args)

  // La extracción viaja en el ctx para que las tools de escritura evalúen el
  // gate de efectos con la señal real del turno.
  const toolCtx: ToolContext = { ...args.ctx, extraction: args.extraction ?? null }

  // Fase 4: pre-match único para S3/S4 (solo gasto; best-effort, no bloquea).
  if (args.extraction && (args.extraction.intent === 'gasto' || args.extraction.intent === 'multi_expense')) {
    try {
      const ext = args.extraction
      const parsed: ParsedExpense = {
        amount: ext.monto,
        description: ext.proveedor
          ? `Pago a ${ext.proveedor}`
          : ext.empleado_gasto
            ? `Pago a ${ext.empleado_gasto}`
            : ext.categoria || 'Pago',
        category: ext.categoria,
        tipoGasto: ext.tipo_gasto ?? null,
        provider: ext.proveedor,
        employee: ext.empleado_gasto,
        payment_method: ext.metodo_pago,
        reference: null,
        date: ext.fecha,
        isExpenseIntent: true,
        raw: args.text,
        amountAmbiguous: ext.dudoso,
        extractorSource: ext.extractor_source,
        confianza: ext.confianza,
      }
      const match = await fuzzyMatchExpense(parsed, { readonly: true })
      toolCtx.preMatch = deriveMatchInfo(match)
    } catch (err) {
      console.warn('[agent] pre-match failed:', err instanceof Error ? err.message : String(err))
    }
  }

  // Fase 4: si el turno anterior dejó una confirmación pendiente, este mensaje
  // la resuelve (confirma / cancela / cambia de tema) antes del loop normal.
  // En modo lectura no se ejecutan pendientes (sería una escritura).
  const pendingReply = allowWrites
    ? await maybeHandlePendingConfirm({
        text: args.text,
        toolCtx,
        extraction: args.extraction ?? null,
      })
    : null
  if (pendingReply) {
    return {
      reply: pendingReply.reply,
      extraction: args.extraction ?? null,
      toolResults: pendingReply.toolResults,
      knowledge: [],
      logs: pendingReply.logs,
      toolLogs: pendingReply.toolLogs,
    }
  }

  const tools = agentToolDefinitions({ includeWrites: allowWrites })
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

      if (!allowWrites && tool.write) {
        logs.push({
          step: 'agent_tool_blocked',
          data: { tool: tool.name, reason: 'writes_disabled' },
        })
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({
            error: 'Las escrituras están deshabilitadas en este turno. Consultá y respondé sin registrar.',
          }),
        })
        continue
      }

      const t0 = Date.now()
      try {
        const out = await tool.execute(toolArgs, toolCtx)
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
