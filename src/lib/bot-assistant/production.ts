import { supabaseAdmin } from '@/lib/ai/admin-client'
import { loadAiConfig } from '@/lib/ai/config'
import { buildConversationContext } from '@/lib/ai/context'
import { retrieveKnowledge } from '@/lib/ai/knowledge'
import { latestUserMessage } from '@/lib/ai/query'
import { engineSendText } from '@/lib/flows/meta-send'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { runAssistant } from './orchestrator'
import { runAssistantAgent } from './agent'
import { fallbackWritesEnabled } from '@/lib/bot/turn-outcome'
import { ASSISTANT_SYSTEM_PROMPT } from './prompts'
import { guardAssistantReply } from './reply-guard'
import { buildBotTrace } from '@/lib/bot-trace/build-trace'
import { recordBotTrace } from '@/lib/bot-trace/record'
import { isPhoneAllowed } from '@/lib/bot/whitelist'
import type { ChatMessage } from '@/lib/ai/types'
import type { UnifiedExtraction } from '@/lib/bot-llm/types'

interface ProductionArgs {
  accountId: string
  conversationId: string
  contactId: string
  userId: string
  text: string
  phone: string
  /** message_id real de Meta: permite enriquecer la MISMA traza/router_logs
   *  del webhook en vez de crear una fila duplicada por turno. */
  messageId?: string | null
  /** Interpretación del webhook, pasada al agente como pista no vinculante. */
  extraction?: UnifiedExtraction | null
  /** Estado multi-turno legible construido por el webhook. */
  conversationContext?: string | null
  /** Contexto del fallback/reintento (turno anterior fallido). */
  retryContext?: string | null
  /** Dominio determinístico que no pudo resolver el turno (null = agente normal). */
  fallbackFrom?: string | null
}

/**
 * Desenlace del asistente, para que el adapter actualice
 * `conversations.bot_last_turn` (fallback/reintento).
 */
export type AssistantOutcome = 'replied' | 'empty' | 'blocked' | 'error'

/**
 * Wrapper productivo del asistente para webhook.
 * Mismo contrato fire-and-forget que dispatchInboundToAiReply: nunca lanza.
 * Gates: assistantEnabled, assigned_agent_id, ai_autoreply_disabled.
 * Historia real + KB + preview readonly + fallback a auto-reply si calla.
 */
export async function runAssistantForWebhook(args: ProductionArgs): Promise<AssistantOutcome> {
  const { accountId, conversationId, contactId, userId, text, phone } = args
  const traceMessageId = args.messageId ?? `assistant-${conversationId}-${Date.now()}`
  console.log('[assistant production] start account=%s conv=%s text=%s', accountId.slice(0, 8), conversationId.slice(0, 8), text.slice(0, 60))
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('[assistant production] OPENROUTER_API_KEY missing — assistant will fail')
  }
  try {
    const db = supabaseAdmin()

    // Defense-in-depth: el webhook ya gatea por whitelist, pero el asistente
    // también puede invocarse por otras vías. Números no autorizados no
    // reciben respuesta del asistente.
    if (!(await isPhoneAllowed(db, accountId, phone))) {
      console.warn('[assistant production] blocked: number not whitelisted phone=%s', phone.slice(-6))
      return 'blocked'
    }

    let config: Awaited<ReturnType<typeof loadAiConfig>> = null
    try {
      config = await loadAiConfig(db, accountId, { requireActive: false })
    } catch (err) {
      console.error('[assistant production] loadAiConfig error:', err instanceof Error ? err.message : String(err))
      // Fallback: si la columna no existe o decrypt falla, no bloquear al asistente — usar default enabled
      config = null
    }
    // Si no hay fila en ai_configs, no bloquear: asistente on por defecto (P2)
    const assistantEnabled = config?.assistantEnabled ?? true
    if (config && !assistantEnabled) {
      console.warn('[assistant production] blocked: assistantEnabled=false account=%s', accountId.slice(0, 8))
      return 'blocked'
    }
    if (!config) {
      console.warn('[assistant production] no ai_configs row — proceeding with default enabled, KB disabled')
      // Crear config mínima en memoria para que retrieveKnowledge no rompa (sin embeddings)
      config = {
        provider: 'openai',
        model: 'gpt-4o-mini',
        apiKey: 'dummy',
        systemPrompt: null,
        isActive: false,
        autoReplyEnabled: false,
        autoReplyMaxPerConversation: 3,
        embeddingsApiKey: null,
        assistantEnabled: true,
      } as unknown as NonNullable<typeof config>
    }

    // Gate: solo humano asignado bloquea al asistente. ai_autoreply_disabled es del auto-reply legacy y no debe silenciar al asistente (se auto-limpia)
    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) {
      console.warn('[assistant production] blocked: conv not found err=%s', convErr?.message ?? 'null')
      return 'blocked'
    }
    if (conv.assigned_agent_id) {
      console.warn('[assistant production] blocked: assigned_agent_id=%s', conv.assigned_agent_id)
      return 'blocked'
    }
    if (conv.ai_autoreply_disabled) {
      console.warn('[assistant production] ai_autoreply_disabled=true — clearing for assistant conv=%s', conversationId.slice(0, 8))
      // Auto-limpiar el flag legacy para que el asistente no quede mudo por un handoff viejo
      try {
        await db.from('conversations').update({ ai_autoreply_disabled: false }).eq('id', conversationId)
      } catch (e) {
        console.warn('[assistant production] clear ai_autoreply_disabled failed:', e instanceof Error ? e.message : String(e))
      }
    }

    // Historial real — últimas N mensajes texto
    let history: ChatMessage[] = []
    try {
      history = await buildConversationContext(db, conversationId)
    } catch {
      history = []
    }

    // KB best-effort
    let knowledge: string[] = []
    try {
      const query = latestUserMessage(history.length > 0 ? history : [{ role: 'user', content: text }])
      knowledge = await retrieveKnowledge(db, accountId, config, query)
    } catch {
      knowledge = []
    }

    console.log('[assistant production] historyLen=%s knowledgeLen=%s', history.length, knowledge.length)
    const useAgent = process.env.ASSISTANT_TOOLS_ENABLED !== 'false'
    const result = useAgent
      ? await runAssistantAgent({
          text,
          history,
          systemPrompt:
            knowledge.length > 0
              ? `${ASSISTANT_SYSTEM_PROMPT}\n\nCONOCIMIENTO:\n${knowledge.join('\n---\n')}`
              : ASSISTANT_SYSTEM_PROMPT,
          extraction: args.extraction,
          conversationContext: args.conversationContext,
          retryContext: args.retryContext ?? null,
          allowWrites: args.fallbackFrom ? fallbackWritesEnabled() : true,
          ctx: {
            db,
            accountId,
            userId,
            conversationId,
            contactId,
            accessToken: '',
            senderPhone: phone,
            senderName: phone,
          },
        })
      : await runAssistant({
          text,
          phone,
          history,
          knowledge,
          readonlyExpensePreview: true,
        })

    const rawReply = (result.reply || '').trim()
    const guard = guardAssistantReply(rawReply)
    const reply = guard.text
    if (guard.blocked) {
      console.warn('[assistant production] G3 guard: respuesta con formato de presupuesto bloqueada conv=%s', conversationId.slice(0, 8))
    }
    console.log('[assistant production] replyPreview=%s toolLogs=%s', reply.slice(0, 200), JSON.stringify(result.toolLogs?.map((t) => `${t.tool}:${t.error ? 'ERR:'+t.error.slice(0,40) : 'OK'}`)))

    // Persist assistant tool debug for bot-debug UI. Se enriquece la MISMA
    // fila de router_logs del webhook (por message_id) en vez de insertar una
    // segunda — evita el log duplicado por turno.
    try {
      const debtInfo = (result.toolResults as Record<string, unknown> | null)?.['deuda_cliente']
        ? { called: true, hasData: true, preview: JSON.stringify((result.toolResults as Record<string,unknown>)['deuda_cliente']).slice(0, 600) }
        : { called: false, reason: result.toolLogs?.some((t) => t.tool.includes('deuda_cliente')) ? 'tool called but empty' : 'no deuda_cliente tool', extraction: result.extraction }
      const debugInfo = {
        extraction: result.extraction,
        toolLogs: result.toolLogs,
        toolResultsPreview: result.toolResults ? Object.fromEntries(Object.entries(result.toolResults).map(([k, v]) => [k, typeof v === 'object' && v !== null ? JSON.stringify(v).slice(0, 1200) : String(v).slice(0, 500)])) : null,
        debtDecision: debtInfo,
        knowledgePreview: knowledge.slice(0, 2),
        replyPreview: reply.slice(0, 400),
        fallbackFrom: args.fallbackFrom ?? null,
        isRetry: !!args.retryContext,
      }
      if (args.messageId) {
        // Merge para no pisar context_text/extraction que ya dejó el webhook.
        const { data: existing } = await db
          .from('router_logs')
          .select('debug_info')
          .eq('message_id', args.messageId)
          .maybeSingle()
        const merged = { ...((existing?.debug_info as Record<string, unknown>) ?? {}), ...debugInfo }
        const update: Record<string, unknown> = { debug_info: merged }
        // El fallback del mismo turno reemplaza el motivo original (el handler
        // declinó); el retry takeover ya quedó como `assistant_retry`.
        if (args.fallbackFrom && args.fallbackFrom !== 'retry') {
          update.dispatch_reason = 'assistant_fallback'
        }
        const { error: upErr } = await db
          .from('router_logs')
          .update(update)
          .eq('message_id', args.messageId)
        if (upErr) console.warn('[assistant production] router_logs update failed:', upErr.message)
      } else {
        await db.from('router_logs').insert({
          message_id: traceMessageId,
          contact_id: contactId,
          conversation_id: conversationId,
          account_id: accountId,
          raw_text: text,
          source: 'assistant',
          flow_consumed: false,
          interactive: false,
          had_context: history.length > 0,
          extractor_source: result.extraction?.extractor_source ?? null,
          intent: result.extraction?.intent ?? null,
          confianza: result.extraction?.confianza ?? null,
          dudoso: result.extraction?.dudoso ?? false,
          faltan_campos: result.extraction?.faltan_campos ?? null,
          dispatched_to: 'assistant',
          dispatch_reason: 'tool_debug',
          debug_info: debugInfo,
        })
      }
    } catch (e) {
      console.warn('[assistant production] router_logs debug persist failed:', e instanceof Error ? e.message : String(e))
    }

    // Traza visual del flujo (diagrama /bot-flow).
    try {
      await recordBotTrace(
        buildBotTrace({
          messageId: traceMessageId,
          producer: 'assistant',
          conversationId,
          contactId,
          accountId,
          source: 'text',
          rawText: text,
          extraction: result.extraction ?? null,
          dispatchedTo: 'assistant',
          dispatchReason: args.fallbackFrom ? 'assistant_fallback' : 'assistant',
          logs: result.logs ?? [],
          finalStatus: 'replied',
        }),
      )
    } catch (e) {
      console.warn('[assistant production] bot_trace failed:', e instanceof Error ? e.message : String(e))
    }
    // Fallback a auto-reply solo si el asistente no produjo texto. No se manda
    // un saludo extra encima: eso producía doble mensaje cuando el auto-reply
    // sí respondía.
    if (!reply) {
      console.warn('[assistant production] empty reply — fallback to auto-reply')
      await dispatchInboundToAiReply({ accountId, conversationId, contactId, configOwnerUserId: userId })
      return 'empty'
    }

    try {
      await engineSendText({
        accountId,
        userId,
        conversationId,
        contactId,
        text: reply,
      })
      console.log('[assistant production] engineSendText OK len=%s', reply.length)
      return 'replied'
    } catch (e) {
      console.error('[assistant production] engineSendText failed:', e instanceof Error ? e.message : String(e), (e as { stack?: string })?.stack?.slice(0, 500))
      return 'error'
    }
  } catch (err) {
    console.error('[assistant production] dispatch failed:', err instanceof Error ? err.message : String(err), (err as { stack?: string })?.stack?.slice(0, 800))
    // Fallback best-effort a auto-reply
    try {
      await dispatchInboundToAiReply({
        accountId,
        conversationId,
        contactId,
        configOwnerUserId: userId,
      })
    } catch {
      // swallow
    }
    // Último recurso si todo falló: saludo mínimo
    try {
      const db2 = supabaseAdmin()
      await engineSendText({
        accountId,
        userId,
        conversationId,
        contactId,
        text: '¡Hola! Estoy acá para ayudarte — ¿qué necesitás?',
      })
      console.log('[assistant production] catch fallback saludo sent')
      void db2
    } catch {
      // swallow
    }
    return 'error'
  }
}
