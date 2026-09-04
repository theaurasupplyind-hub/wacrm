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
  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId, { requireActive: false })
    const assistantEnabled = config?.assistantEnabled ?? true
    if (!config || !assistantEnabled) return

    // Gates iguales a auto-reply: humano asignado o hilo silenciado
    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return
    if (conv.assigned_agent_id) return
    if (conv.ai_autoreply_disabled) return

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

    const result = await runAssistant({
      text,
      phone,
      history,
      knowledge,
      readonlyExpensePreview: true,
    })

    const reply = (result.reply || '').trim()
    // Si no hay reply o marca escalamiento → fallback a auto-reply
    const needsEscalation = /\/bot-escalations/i.test(reply) || reply.length === 0
    if (!reply || needsEscalation) {
      await dispatchInboundToAiReply({ accountId, conversationId, contactId, configOwnerUserId: userId })
      return
    }

    await engineSendText({
      accountId,
      userId,
      conversationId,
      contactId,
      text: reply,
    })
  } catch (err) {
    console.error('[assistant production] dispatch failed:', err)
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
  }
}
