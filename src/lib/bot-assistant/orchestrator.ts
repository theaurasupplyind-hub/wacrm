import { extractBotMessage } from '@/lib/bot-llm/extract-bot-message'
import { buildHistoryText } from './history'
import { generateAssistantReply } from './responder'
import { runToolsForQuery, type ToolLog } from './tools'
import type { UnifiedExtraction } from '@/lib/bot-llm/types'

export interface AssistantResult {
  reply: string
  extraction: UnifiedExtraction | null
  toolResults: Record<string, unknown> | null
  knowledge: string[]
  logs: { step: string; data: unknown }[]
  pendingState?: unknown
  toolLogs?: ToolLog[]
}

function shouldCallTools(extraction: UnifiedExtraction | null, text: string): boolean {
  if (!extraction) return false
  const q = text.toLowerCase()
  const factualKeywords = ['cuanto', 'cuánto', 'cuando', 'cuándo', 'quien', 'quién', 'cuantos', 'qué', 'que paso', 'saldo', 'debo', 'debe', 'gasto', 'gasté', 'gaste', 'hoy', 'ayer', 'factura', 'proveedor', 'empleado', 'asistencia', 'faltó', 'falto', 'llegó', 'precio', 'presupuesto']
  const hasFactualKeyword = factualKeywords.some((k) => q.includes(k))
  // Siempre tools si intent no es "otro" con baja, o si hay keyword factual
  if (extraction.intent !== 'otro' && extraction.confianza !== 'baja') return true
  if (hasFactualKeyword) return true
  // factura siempre necesita dato real
  if (extraction.intent === 'factura') return true
  // asistencia siempre
  if (extraction.intent.startsWith('asistencia')) return true
  // gasto/multi_expense
  if (extraction.intent === 'gasto' || extraction.intent === 'multi_expense') return true
  return false
}

export async function runAssistant(args: {
  text: string
  phone: string
  history: { role: string; content: string }[]
  pendingState?: unknown
}): Promise<AssistantResult> {
  const logs: { step: string; data: unknown }[] = []
  const historyText = buildHistoryText(args.history)
  logs.push({ step: 'assistant_history', data: { historyText: historyText.slice(0, 2000) } })

  const t0 = Date.now()
  let extraction: UnifiedExtraction | null = null
  try {
    extraction = await extractBotMessage(args.text, historyText || undefined)
    logs.push({
      step: 'assistant_extraction',
      data: { extraction, duration_ms: Date.now() - t0 },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logs.push({ step: 'assistant_extraction_error', data: { error: msg } })
  }

  let toolResults: Record<string, unknown> | null = null
  let toolLogs: ToolLog[] = []
  const knowledge: string[] = []

  // Knowledge: best-effort no bloqueante; en Bot Beta sin accountId/supabase no hay KB → vacío
  // Se deja hook para Fase 3 si hay accountId disponible.

  const needsTools = shouldCallTools(extraction, args.text)

  if (needsTools && extraction) {
    try {
      const r = await runToolsForQuery({
        text: args.text,
        intent: extraction.intent,
        proveedor: extraction.proveedor,
        empleado: extraction.empleado || extraction.empleado_gasto,
        fecha: extraction.fecha,
      })
      toolResults = r.toolResults
      toolLogs = r.toolLogs
      logs.push({ step: 'assistant_tools', data: { toolLogs, toolResultsPreview: Object.fromEntries(Object.entries(toolResults).map(([k, v]) => [k, Array.isArray(v) ? `array(${v.length})` : typeof v === 'object' && v !== null ? Object.keys(v as object) : v])) } })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logs.push({ step: 'assistant_tools_error', data: { error: msg } })
      toolResults = { _error: msg }
    }
  } else {
    logs.push({ step: 'assistant_tools', data: { skipped: true, reason: 'chitchat or low confidence otro' } })
  }

  const replyT0 = Date.now()
  let reply = ''
  try {
    reply = await generateAssistantReply({
      historyText: historyText ? `${historyText}\nuser: ${args.text}` : `user: ${args.text}`,
      extraction,
      toolResults,
      knowledge,
    })
    logs.push({ step: 'assistant_response', data: { reply_preview: reply.slice(0, 300), duration_ms: Date.now() - replyT0 } })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logs.push({ step: 'assistant_response_error', data: { error: msg } })
    reply = 'Che, se me complicó responder ahora. Probá de nuevo en un toque. Si es urgente lo dejamos en /bot-escalations.'
  }

  return {
    reply,
    extraction,
    toolResults,
    knowledge,
    logs,
    toolLogs,
  }
}
