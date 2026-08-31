import { createClient } from '@supabase/supabase-js'
import { extractBotMessage } from '@/lib/bot-llm/extract-bot-message'
import { buildBotContextText } from '@/lib/bot-llm/context'
import { decideDispatch } from '@/lib/bot/router'
import { runAssistant } from '@/lib/bot-assistant/orchestrator'
import { loadExpenseContext } from '@/lib/expenses/context'
import { loadAttendanceContext } from '@/lib/attendance/context'
import { loadVoucherContext } from '@/lib/ai/voucher-context'
import type { UnifiedExtraction } from '@/lib/bot-llm/types'

export const BOT_BETA_DUMMY_PHONE = '11999999999'
export const BOT_BETA_DUMMY_NAME = 'BotBeta Dummy'

function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key)
}

async function getOrCreateDummyConversation(accountId: string, userId: string) {
  const admin = supabaseAdmin()
  if (!admin) return null

  // Find or create contact dummy
  let contactId: string | null = null
  const { data: existingContact } = await admin
    .from('contacts')
    .select('id')
    .eq('account_id', accountId)
    .eq('phone', BOT_BETA_DUMMY_PHONE)
    .maybeSingle()

  if (existingContact) {
    contactId = existingContact.id
  } else {
    const { data: newContact, error } = await admin
      .from('contacts')
      .insert({
        account_id: accountId,
        user_id: userId,
        phone: BOT_BETA_DUMMY_PHONE,
        name: BOT_BETA_DUMMY_NAME,
      })
      .select('id')
      .single()
    if (error || !newContact) {
      console.error('[bot-beta] create dummy contact failed', error)
      return null
    }
    contactId = newContact.id
  }

  const { data: existingConv } = await admin
    .from('conversations')
    .select('id, voice_context, expense_context, attendance_context, voucher_context')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .maybeSingle()

  if (existingConv) return { conversationId: existingConv.id as string, contactId }

  const { data: newConv, error: convErr } = await admin
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: userId,
      contact_id: contactId,
    })
    .select('id')
    .single()

  if (convErr || !newConv) {
    console.error('[bot-beta] create dummy conversation failed', convErr)
    return null
  }
  return { conversationId: newConv.id as string, contactId }
}

export interface UnifiedRunArgs {
  text: string
  accountId?: string | null
  userId?: string | null
  history?: { role: string; content: string }[]
}

export interface UnifiedRunResult {
  reply: string
  dispatchedTo: string
  dispatchReason: string
  extraction: UnifiedExtraction | null
  toolResults: Record<string, unknown> | null
  toolLogs?: { tool: string; duration_ms: number; resultCount?: number; error?: string }[]
  knowledge: string[]
  logs: { step: string; data: unknown }[]
  dummyConversationId: string | null
  transcription?: string
}

export async function runUnifiedBotBeta(args: UnifiedRunArgs): Promise<UnifiedRunResult> {
  const text = (args.text || '').trim()
  const logs: { step: string; data: unknown }[] = []

  if (!text) {
    return {
      reply: 'Escribí un mensaje.',
      dispatchedTo: 'none',
      dispatchReason: 'none',
      extraction: null,
      toolResults: null,
      knowledge: [],
      logs,
      dummyConversationId: null,
    }
  }

  let dummyConversationId: string | null = null
  let expenseCtx: unknown = null
  let attendanceCtx: unknown = null
  let voucherCtx: unknown = null
  let voiceCtx: unknown = null
  let contextText = ''

  // Best-effort load of production contexts for the dummy conversation
  const admin = supabaseAdmin()
  const hasSupabase = !!admin && !!args.accountId && !!args.userId

  if (hasSupabase && args.accountId && args.userId) {
    try {
      const dummy = await getOrCreateDummyConversation(args.accountId, args.userId)
      if (dummy) {
        dummyConversationId = dummy.conversationId
        const [exp, att, vou] = await Promise.all([
          loadExpenseContext(admin!, dummy.conversationId),
          loadAttendanceContext(admin!, dummy.conversationId),
          loadVoucherContext(admin!, dummy.conversationId),
        ])
        expenseCtx = exp
        attendanceCtx = att
        voucherCtx = vou
        // voice_ctx
        const { data: conv } = await admin!.from('conversations').select('voice_context').eq('id', dummy.conversationId).maybeSingle()
        voiceCtx = (conv as { voice_context?: unknown })?.voice_context || null

        contextText = buildBotContextText({
          expenseCtx: exp as never,
          attendanceCtx: att as never,
          voucherCtx: vou as never,
          voiceCtx: voiceCtx as never,
        })
        logs.push({ step: 'botbeta_context', data: { dummyConversationId, contextText: contextText.slice(0, 1500), hasPendingExpense: !!(exp as { pendingExpense?: unknown })?.pendingExpense } })
      }
    } catch (err) {
      logs.push({ step: 'botbeta_context_error', data: { error: err instanceof Error ? err.message : String(err) } })
    }
  } else {
    // Fallback: history-based context (no Supabase)
    const historyText = (args.history || []).slice(-10).map((t) => `${t.role}: ${t.content}`).join('\n')
    if (historyText) contextText = historyText
    logs.push({ step: 'botbeta_no_supabase', data: { reason: 'no accountId/userId or env missing, using history only' } })
  }

  // If we still have history and no contextText, merge
  if (!contextText && args.history?.length) {
    contextText = args.history.slice(-10).map((t) => `${t.role}: ${t.content}`).join('\n')
  }

  let extraction: UnifiedExtraction | null = null
  try {
    extraction = await extractBotMessage(text, contextText || undefined)
    logs.push({ step: 'assistant_extraction', data: { extraction } })
  } catch (err) {
    logs.push({ step: 'assistant_extraction_error', data: { error: err instanceof Error ? err.message : String(err) } })
  }

  // Derive pending flags same as webhook
  const expCtx = expenseCtx as { pendingExpense?: unknown; pendingMultiple?: unknown; stage?: string; correctingCategory?: boolean } | null
  const hasPendingExpense = !!expCtx && (
    ((!!expCtx.pendingExpense || !!expCtx.pendingMultiple) &&
      (expCtx.stage === 'collecting' || expCtx.stage === 'confirming')) ||
      expCtx.correctingCategory === true
  )

  const attCtx = attendanceCtx as { pendingType?: unknown; awaitingCorrection?: boolean } | null
  const hasPendingAttendance = !!attCtx && (!!attCtx.pendingType || attCtx.awaitingCorrection === true)

  const vouCtx = voucherCtx as { pending?: unknown[] } | null
  const hasPendingVoucherFlag = !!vouCtx && Array.isArray(vouCtx.pending) && vouCtx.pending.length > 0

  const decision = decideDispatch({
    hasPendingExpense,
    hasPendingAttendance,
    hasPendingVoucher: hasPendingVoucherFlag,
    flowConsumed: false,
    interactiveReplyId: null,
    inboundText: text,
    extraction,
    mediaConsumedByVoucher: false,
  })

  logs.push({ step: 'botbeta_router', data: { decision, hasPendingExpense, hasPendingAttendance, hasPendingVoucher: hasPendingVoucherFlag } })

  // If router decides a deterministic handler, we still want to show what would happen,
  // but the conversational layer is the fallback for 'none'. For 'expense/attendance/voice/voucher'
  // we delegate to runAssistant which already handles grounded preview (expense_preview) and tools.
  // This keeps BotBeta aligned: deterministic via preview + conversational verbalization.

  // Always run assistant — it internally decides tools + preview deterministically.
  // For deterministic intents it will produce a grounded reply via expense_preview / tools.
  const assistantResult = await runAssistant({
    text,
    phone: BOT_BETA_DUMMY_PHONE,
    history: args.history || [],
  })

  // Merge logs
  const allLogs = [...logs, ...assistantResult.logs]

  // Override dispatchedTo when assistant would have handled via 'none' but we know router says something
  // Keep router decision as source of truth for badge
  const finalDispatchedTo = decision.dispatchedTo === 'none' ? 'assistant' : decision.dispatchedTo

  return {
    reply: assistantResult.reply,
    dispatchedTo: finalDispatchedTo,
    dispatchReason: decision.dispatchReason,
    extraction: assistantResult.extraction ?? extraction,
    toolResults: assistantResult.toolResults,
    toolLogs: assistantResult.toolLogs,
    knowledge: assistantResult.knowledge,
    logs: allLogs,
    dummyConversationId,
  }
}
