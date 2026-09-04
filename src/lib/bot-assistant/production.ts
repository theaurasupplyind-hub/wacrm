import { supabaseAdmin } from '@/lib/ai/admin-client'
import { loadAiConfig } from '@/lib/ai/config'
import { buildConversationContext } from '@/lib/ai/context'
import { retrieveKnowledge } from '@/lib/ai/knowledge'
import { latestUserMessage } from '@/lib/ai/query'
import { engineSendText } from '@/lib/flows/meta-send'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { runAssistant } from './orchestrator'
import type { ChatMessage } from '@/lib/ai/types'

interface ProductionArgs {
  accountId: string
  conversationId: string
  contactId: string
  userId: string
  text: string
  phone: string
}

/**
 * Wrapper productivo del asistente para webhook.
 * Mismo contrato fire-and-forget que dispatchInboundToAiReply: nunca lanza.
 * Gates: assistantEnabled, assigned_agent_id, ai_autoreply_disabled.
 * Historia real + KB + preview readonly + fallback a auto-reply si calla.
 */
export async function runAssistantForWebhook(args: ProductionArgs): Promise<void> {
  const { accountId, conversationId, contactId, userId, text, phone } = args
  console.log('[assistant production] start account=%s conv=%s text=%s', accountId.slice(0, 8), conversationId.slice(0, 8), text.slice(0, 60))
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('[assistant production] OPENROUTER_API_KEY missing — assistant will fail')
  }
  try {
    const db = supabaseAdmin()

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
      return
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
      return
    }
    if (conv.assigned_agent_id) {
      console.warn('[assistant production] blocked: assigned_agent_id=%s', conv.assigned_agent_id)
      return
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
    const result = await runAssistant({
      text,
      phone,
      history,
      knowledge,
      readonlyExpensePreview: true,
    })

    let reply = (result.reply || '').trim()
    console.log('[assistant production] replyPreview=%s escalation=%s toolLogs=%s', reply.slice(0, 200), /\/bot-escalations/i.test(reply), JSON.stringify(result.toolLogs?.map((t) => t.tool).slice(0, 3)))
    // Fallback a auto-reply solo si realmente no hay texto; si hay escalamiento, stripear y mandar igual (P3)
    const needsEscalation = /\/bot-escalations/i.test(reply)
    if (!reply) {
      console.warn('[assistant production] empty reply — fallback to auto-reply')
      await dispatchInboundToAiReply({ accountId, conversationId, contactId, configOwnerUserId: userId })
      // Si auto-reply tampoco mandó (off), mandar saludo mínimo para que Hola nunca quede mudo (P3)
      const { data: convCheck } = await db.from('conversations').select('ai_reply_count').eq('id', conversationId).maybeSingle()
      console.warn('[assistant production] empty reply fallback done convCheck=%s', JSON.stringify(convCheck))
      // Último recurso: mandar saludo aunque auto-reply haya hecho return
      const fallbackText = '¡Hola! Soy el asistente de Bastidores GAL 👋 ¿En qué te ayudo hoy?'
      try {
        await engineSendText({ accountId, userId, conversationId, contactId, text: fallbackText })
        console.log('[assistant production] fallback saludo sent')
      } catch (e) {
        console.error('[assistant production] fallback saludo failed:', e instanceof Error ? e.message : String(e))
      }
      return
    }
    if (needsEscalation) {
      console.warn('[assistant production] escalation marker in reply — stripping and sending anyway')
      reply = reply.replace(/\/bot-escalations/gi, '').trim() || '¡Hola! Te ayudo con eso — decime más detalles y lo vemos.'
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
    } catch (e) {
      console.error('[assistant production] engineSendText failed:', e instanceof Error ? e.message : String(e), (e as { stack?: string })?.stack?.slice(0, 500))
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
  }
}
