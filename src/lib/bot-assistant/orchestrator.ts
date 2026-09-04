import { extractBotMessage } from '@/lib/bot-llm/extract-bot-message'
import { buildHistoryText } from './history'
import { generateAssistantReply } from './responder'
import { runToolsForQuery, type ToolLog } from './tools'
import type { UnifiedExtraction } from '@/lib/bot-llm/types'
import { fuzzyMatchExpense } from '@/lib/expenses/fuzzy-match'
import type { ParsedExpense } from '@/lib/expenses/types'

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
  // Identidad: nunca tools (evita listExpenses para "quien sos")
  if (/quien\s*(sos|eres|es)\b/.test(q) || /\bque\s*sos\b/.test(q) || q.trim() === 'quien sos' || q.trim() === 'quien eres') return false
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
  knowledge?: string[]
  readonlyExpensePreview?: boolean
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
  const knowledge: string[] = args.knowledge ?? []

  // Knowledge ya viene del caller (Fase 3); en Bot Beta dummy sigue []

  const needsTools = shouldCallTools(extraction, args.text)

  // Helper: inferencia determinística de gasto (sin escribir) para no preguntar categoría si es sueldo
  async function buildExpensePreview(ext: UnifiedExtraction, t0: number): Promise<void> {
    // Solo si hay monto (igualmente inferimos para "pagué a X" aunque monto esté en palabras ya normalizado)
    if (ext.monto == null && !ext.proveedor && !ext.empleado_gasto) return
    const parsed: ParsedExpense = {
      amount: ext.monto,
      description: ext.proveedor ? `Pago a ${ext.proveedor}` : ext.empleado_gasto ? `Pago a ${ext.empleado_gasto}` : ext.categoria || 'Pago',
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
    try {
      const match = await fuzzyMatchExpense(parsed, { readonly: !!args.readonlyExpensePreview })
      // Normalizamos: si matcheó empleado, forzamos preview de sueldo aunque LLM no haya puesto categoría
      const inferredIsSalary = !!match.employeeId || !!match.employeeName
      const inferredCategory = match.categoryName || (inferredIsSalary ? 'Sueldos y salarios' : null)
      // Inicializa toolResults si venía vacío
      if (!toolResults) toolResults = {}
      toolResults['expense_preview'] = {
        inferred: true,
        isSalary: inferredIsSalary,
        categoryName: inferredCategory,
        categoryWasCreated: match.categoryWasCreated,
        employeeId: match.employeeId,
        employeeName: match.employeeName,
        providerId: match.providerId,
        providerName: match.providerName,
        matchCategoryId: match.categoryId,
      }
      toolLogs.push({ tool: 'fuzzyMatchExpense', duration_ms: Date.now() - t0, resultCount: match.categoryId ? 1 : 0 })
      logs.push({ step: 'assistant_expense_preview', data: { match, inferredIsSalary, inferredCategory } })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logs.push({ step: 'assistant_expense_preview_error', data: { error: msg } })
      if (!toolResults) toolResults = {}
      toolResults['expense_preview'] = { inferred: false, error: msg }
      toolLogs.push({ tool: 'fuzzyMatchExpense', duration_ms: Date.now() - t0, error: msg })
    }
  }

  if (needsTools && extraction) {
    try {
      const r = await runToolsForQuery({
        text: args.text,
        intent: extraction.intent,
        proveedor: extraction.proveedor,
        empleado: extraction.empleado || extraction.empleado_gasto,
        fecha: extraction.fecha,
        historyText,
      })
      toolResults = r.toolResults
      toolLogs = r.toolLogs
      logs.push({ step: 'assistant_tools', data: { toolLogs, toolResultsPreview: Object.fromEntries(Object.entries(toolResults).map(([k, v]) => [k, Array.isArray(v) ? `array(${v.length})` : typeof v === 'object' && v !== null ? Object.keys(v as object) : v])) } })

      // Si es gasto / multi_expense con confianza no-baja, corre preview determinístico en paralelo (best-effort)
      if ((extraction.intent === 'gasto' || extraction.intent === 'multi_expense') && extraction.confianza !== 'baja') {
        await buildExpensePreview(extraction, Date.now())
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logs.push({ step: 'assistant_tools_error', data: { error: msg } })
      toolResults = { _error: msg }
    }
  } else {
    logs.push({ step: 'assistant_tools', data: { skipped: true, reason: 'chitchat or low confidence otro' } })
    // Aun sin tools por keyword, si es gasto explícito intentamos preview para inferir sueldo
    if (extraction && (extraction.intent === 'gasto' || extraction.intent === 'multi_expense') && extraction.confianza !== 'baja') {
      try {
        const r = await runToolsForQuery({
          text: args.text,
          intent: extraction.intent,
          proveedor: extraction.proveedor,
          empleado: extraction.empleado || extraction.empleado_gasto,
          fecha: extraction.fecha,
          historyText,
        })
        toolResults = r.toolResults
        toolLogs = r.toolLogs
        await buildExpensePreview(extraction, Date.now())
      } catch {
        // ignorar, ya logueado arriba
      }
    }
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
