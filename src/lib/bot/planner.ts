/**
 * Planner LLM — FASE 3 (sombra).
 *
 * El planner PROPONE acciones (nunca ejecuta). En Fase 3 corre en paralelo al
 * ruteo determinístico y sólo se registra: no cambia nada de lo que se ejecuta.
 *
 * Reusa el agente existente en vez de crear un tercer loop de tool-calling:
 *   - mensajes: `buildAgentMessages` (bot-assistant/agent.ts)
 *   - tools:    `agentToolDefinitions` (bot-assistant/tool-registry.ts)
 *
 * Flag: `ASSISTANT_AGENT_PLANNER = off | shadow | on` (default `off`).
 * En Fase 3 sólo `shadow` (y `on`, aún sin dientes) registran; `off` no llama
 * al LLM.
 */

import { callOpenRouterChat, type ChatMessage, type ToolCall } from '@/lib/ai/openrouter'
import { buildAgentMessages } from '@/lib/bot-assistant/agent'
import { agentToolDefinitions } from '@/lib/bot-assistant/tool-registry'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { buildBotTrace } from '@/lib/bot-trace/build-trace'
import { recordBotTrace } from '@/lib/bot-trace/record'
import type { UnifiedExtraction } from '@/lib/bot-llm/types'
import type { TurnAction } from './actions'

export type PlannerMode = 'off' | 'shadow' | 'on'

export function getPlannerMode(): PlannerMode {
  const raw = (process.env.ASSISTANT_AGENT_PLANNER || 'off').trim().toLowerCase()
  if (raw === 'shadow' || raw === 'on') return raw
  return 'off'
}

export const PLANNER_SYSTEM_PROMPT = `Sos el PLANIFICADOR de un ERP por WhatsApp. Tu único trabajo es proponer QUÉ acción tomar ante el mensaje del usuario, usando las herramientas disponibles. NO respondés al usuario y NO inventás datos.

Reglas duras:
- Los montos, precios, IDs, categorías y empleados/proveedores SIEMPRE salen de las herramientas o del texto; nunca los inventes.
- Si el mensaje es una orden de negocio clara (registrar un gasto, registrar asistencia, cotizar/crear un presupuesto), llamá a la herramienta correspondiente.
- Si es una consulta (deuda, saldos, catálogo, precios, proveedores, empleados), usá la herramienta de lectura.
- Si es charla/saludo o no es una acción de negocio, NO llames herramientas.
- Como máximo UNA acción de escritura por turno.

Para "registrar_gasto" pasá el texto tal cual lo dijo el usuario. Para "registrar_asistencia" ídem. Para "cotizar_pedido" pasá la frase con medidas/productos.`

/** Herramientas que implican el dominio de pedidos. */
const ORDER_TOOLS = new Set(['cotizar_pedido', 'buscar_productos'])

export interface PlannerProposal {
  actions: TurnAction[]
  /** Dominios a los que el planner rutearía (expense/attendance/pedido/assistant/voucher). */
  domains: string[]
  /** Tool names de escritura propuestas (registrar_gasto / registrar_asistencia). */
  writes: string[]
  confidence: 'alta' | 'media' | 'baja'
  usedTools: string[]
  rationale?: string
}

/**
 * Mapea los tool calls del LLM a acciones propuestas. El LLM no ejecuta nada:
 * esto es una interpretación para comparar/registrar.
 */
export function proposeActions(
  toolCalls: ToolCall[],
  text: string,
  extraction: UnifiedExtraction | null,
): PlannerProposal {
  const domains = new Set<string>()
  const writes: string[] = []
  const usedTools: string[] = []
  const actions: TurnAction[] = []

  const writeActions: TurnAction[] = []
  let wantsAssistant = false
  let wantsOrder = false

  for (const call of toolCalls) {
    const name = call.function?.name
    if (!name) continue
    usedTools.push(name)
    // Deliberadamente NO se leen los argumentos del modelo: los datos de
    // negocio (montos/IDs/proveedores) salen del texto del usuario y de los
    // handlers, nunca del JSON que propone el LLM.

    if (name === 'registrar_gasto') {
      writes.push(name)
      domains.add('expense')
      // Fase 5: la acción usa el TEXTO DEL USUARIO, no el que devolvió el modelo
      // (`args.texto` es sólo una pista y no se confía en él para datos de negocio).
      writeActions.push({ kind: 'run_expense', text, extraction })
    } else if (name === 'registrar_asistencia') {
      writes.push(name)
      domains.add('attendance')
      writeActions.push({ kind: 'run_attendance', text, extraction })
    } else if (name === 'cotizar_pedido') {
      domains.add('pedido')
      wantsOrder = true
    } else if (ORDER_TOOLS.has(name)) {
      domains.add('pedido')
      wantsAssistant = true
    } else {
      // consultar_facturas / listar_* / buscar_* → lectura por el asistente
      domains.add('assistant')
      wantsAssistant = true
    }
  }

  // Una sola escritura por turno (maxWritesPerTurn).
  if (writeActions.length > 0) {
    actions.push(writeActions[0])
  } else if (wantsOrder) {
    domains.add('pedido')
    actions.push({ kind: 'run_order', text })
  } else if (wantsAssistant || usedTools.length > 0) {
    domains.add('assistant')
    actions.push({ kind: 'run_assistant', text, extraction })
  } else {
    domains.add('assistant')
    actions.push({ kind: 'reply_text', text })
  }

  const confidence: PlannerProposal['confidence'] =
    writeActions.length > 0 ? 'alta' : usedTools.length > 0 ? 'media' : 'baja'

  return {
    actions,
    domains: [...domains],
    writes,
    confidence,
    usedTools,
  }
}

/** Limpia el placehold: `proposeActions` devuelve acciones tipadas válidas. */
export type PlannerProposalInput = {
  text: string
  extraction: UnifiedExtraction | null
  conversationContext?: string | null
  history?: { role: string; content: string }[]
}

export interface PlannerRunResult {
  proposal: PlannerProposal | null
  latencyMs: number
  modelUsed: string | null
  usage?: { prompt_tokens: number; completion_tokens: number }
  error?: string
}

/**
 * Corre el planner una vez (sin ejecutar acciones). Nunca lanza.
 */
export async function runPlanner(input: PlannerProposalInput): Promise<PlannerRunResult> {
  const t0 = Date.now()
  const model = process.env.PLANNER_MODEL || process.env.ASSISTANT_MODEL || undefined
  try {
    const messages: ChatMessage[] = buildAgentMessages({
      text: input.text,
      history: input.history ?? [],
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      extraction: input.extraction ?? undefined,
      conversationContext: input.conversationContext ?? undefined,
    })
    const res = await callOpenRouterChat({
      messages,
      tools: agentToolDefinitions(),
      toolChoice: 'auto',
      model,
      temperature: 0,
      maxTokens: 500,
    })
    const proposal = proposeActions(res.toolCalls, input.text, input.extraction)
    if (res.text && !proposal.rationale) proposal.rationale = res.text.slice(0, 400)
    return {
      proposal,
      latencyMs: Date.now() - t0,
      modelUsed: model ?? null,
      usage: res.usage,
    }
  } catch (err) {
    return {
      proposal: null,
      latencyMs: Date.now() - t0,
      modelUsed: model ?? null,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ─── Comparación sombra (determinístico vs planner) ───

export interface ShadowComparison {
  deterministicDomain: string
  deterministicReason: string
  plannerDomains: string[]
  plannerWrites: string[]
  /** false para turnos fuera de alcance del planner (voucher/clarify/interactive/…) — no entran a las métricas. */
  applicable: boolean
  agrees: boolean
  unnecessaryWrite: boolean
  missedWrite: boolean
  latched: 'ok' | 'error'
  latencyMs: number
  usedTools: string[]
  confidence: string | null
  modelUsed: string | null
  error?: string
}

/**
 * Dominios donde el planner puede proponer una **escritura de negocio** real
 * (llamando a `registrar_gasto`/`registrar_asistencia`). `pedido` y `voucher`
 * NO cuentan: pedido es cotización/consulta (el handler de pedidos confirma la
 * creación por su cuenta) y voucher está congelado.
 */
const PLANNER_WRITE_DOMAINS = new Set(['expense', 'attendance'])

/**
 * Dominios donde la comparación determinístico↔planner es significativa.
 * Fuera: `voucher` (congelado), `clarify`/`interactive`/`flow`/`none` (el
 * planner no aplica). Estos turnos se registran pero NO entran a las métricas.
 */
const COMPARABLE_DOMAINS = new Set(['expense', 'attendance', 'pedido', 'assistant'])

export function compareShadow(args: {
  deterministicDomain: string
  deterministicReason: string
  result: PlannerRunResult
}): ShadowComparison {
  const { deterministicDomain, deterministicReason, result } = args
  const p = result.proposal
  const domains = p?.domains ?? []
  const writes = p?.writes ?? []
  const applicable = COMPARABLE_DOMAINS.has(deterministicDomain)
  const detIsWrite = PLANNER_WRITE_DOMAINS.has(deterministicDomain)

  // Acuerdo por DOMINIO (no por "escribió"): pedido/consulta son válidos.
  const agrees = applicable && domains.includes(deterministicDomain)

  return {
    deterministicDomain,
    deterministicReason,
    plannerDomains: domains,
    plannerWrites: writes,
    applicable,
    agrees,
    // LLM propone escribir cuando el determinístico NO iba a escribir → falso positivo.
    unnecessaryWrite: writes.length > 0 && !detIsWrite,
    // El determinístico iba a escribir (gasto/asistencia) y el planner no lo propuso.
    missedWrite: detIsWrite && writes.length === 0,
    latched: result.error ? 'error' : 'ok',
    latencyMs: result.latencyMs,
    usedTools: p?.usedTools ?? [],
    confidence: p?.confidence ?? null,
    modelUsed: result.modelUsed,
    error: result.error,
  }
}

// ─── Persistencia de la sombra ───

export interface RecordShadowArgs {
  messageId: string
  accountId: string
  conversationId: string
  contactId: string
  source?: string | null
  comparison: ShadowComparison
  proposal: TurnAction[] | null
  /** Fase 4: quién condujo el turno (determinístico vs planner) y por qué. */
  drive?: { source: 'deterministic' | 'planner'; reason: string } | null
}

/**
 * Registra la propuesta del planner sin ejecutarla:
 *  - `router_logs.debug_info.planner_shadow` (merge por message_id)
 *  - `bot_traces` (merge por message_id) como step `planner_shadow`.
 * Nunca lanza.
 */
export async function recordPlannerShadow(args: RecordShadowArgs): Promise<void> {
  const { messageId, comparison } = args
  try {
    const db = supabaseAdmin()
    const { data: existing } = await db
      .from('router_logs')
      .select('debug_info')
      .eq('message_id', messageId)
      .maybeSingle()
    const merged = {
      ...((existing?.debug_info as Record<string, unknown>) ?? {}),
      planner_shadow: {
        mode: getPlannerMode(),
        drive: args.drive ?? null,
        deterministic: {
          domain: comparison.deterministicDomain,
          reason: comparison.deterministicReason,
        },
        planner: {
          domains: comparison.plannerDomains,
          writes: comparison.plannerWrites,
          usedTools: comparison.usedTools,
          confidence: comparison.confidence,
          actions: args.proposal?.map((a) => a.kind) ?? null,
        },
        agrees: comparison.agrees,
        unnecessaryWrite: comparison.unnecessaryWrite,
        missedWrite: comparison.missedWrite,
        latencyMs: comparison.latencyMs,
        modelUsed: comparison.modelUsed,
        error: comparison.error ?? null,
      },
    }
    const { error } = await db.from('router_logs').update({ debug_info: merged }).eq('message_id', messageId)
    if (error) console.warn('[planner-shadow] router_logs update failed:', error.message)
  } catch (err) {
    console.warn('[planner-shadow] router_logs persist failed:', err instanceof Error ? err.message : String(err))
  }

  try {
    await recordBotTrace(
      buildBotTrace({
        messageId,
        producer: 'planner-shadow',
        conversationId: args.conversationId,
        contactId: args.contactId,
        accountId: args.accountId,
        source: args.source ?? 'text',
        dispatchedTo: comparison.deterministicDomain,
        dispatchReason: comparison.deterministicReason,
        logs: [{ step: 'planner_shadow', data: comparison }],
        includeTerminal: false,
      }),
    )
  } catch (err) {
    console.warn('[planner-shadow] bot_trace failed:', err instanceof Error ? err.message : String(err))
  }
}

export interface PlannerShadowInput extends PlannerProposalInput {
  messageId: string
  accountId: string
  conversationId: string
  contactId: string
  source?: string | null
  deterministicDomain: string
  deterministicReason: string
}

/**
 * Entrada de la sombra: corre el planner, compara con el determinístico y
 * persiste. NO ejecuta acciones. Devuelve la comparación (para tests/logs).
 */
export async function runPlannerShadow(input: PlannerShadowInput): Promise<ShadowComparison> {
  const mode = getPlannerMode()
  if (mode === 'off') {
    return compareShadow({
      deterministicDomain: input.deterministicDomain,
      deterministicReason: input.deterministicReason,
      result: { proposal: null, latencyMs: 0, modelUsed: null, error: 'planner_off' },
    })
  }
  if (mode === 'on') {
    console.warn('[planner-shadow] ASSISTANT_AGENT_PLANNER=on todavía no ejecuta (Fase 4): se registra en sombra.')
  }
  const result = await runPlanner(input)
  const comparison = compareShadow({
    deterministicDomain: input.deterministicDomain,
    deterministicReason: input.deterministicReason,
    result,
  })
  console.log(
    '[planner-shadow] det=%s/%s planner=%s writes=%s agrees=%s unnecesaryWrite=%s lat=%dms err=%s',
    comparison.deterministicDomain,
    comparison.deterministicReason,
    comparison.plannerDomains.join('|') || '-',
    comparison.plannerWrites.join('|') || '-',
    comparison.agrees,
    comparison.unnecessaryWrite,
    comparison.latencyMs,
    comparison.error ?? '-',
  )
  if (input.messageId) {
    await recordPlannerShadow({
      messageId: input.messageId,
      accountId: input.accountId,
      conversationId: input.conversationId,
      contactId: input.contactId,
      source: input.source,
      comparison,
      proposal: result.proposal?.actions ?? null,
    })
  }
  return comparison
}
