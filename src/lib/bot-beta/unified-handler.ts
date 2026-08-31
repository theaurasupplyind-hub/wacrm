import { createClient } from '@supabase/supabase-js'
import { extractBotMessage } from '@/lib/bot-llm/extract-bot-message'
import { buildBotContextText } from '@/lib/bot-llm/context'
import { decideDispatch } from '@/lib/bot/router'
import { runAssistant } from '@/lib/bot-assistant/orchestrator'
import { loadExpenseContext } from '@/lib/expenses/context'
import { loadAttendanceContext } from '@/lib/attendance/context'
import { loadVoucherContext, saveVoucherContext } from '@/lib/ai/voucher-context'
import type { UnifiedExtraction } from '@/lib/bot-llm/types'
import { matchVoucherByName } from '@/lib/facbal/client'
import { getMontoTolerancia } from '@/lib/ai/voucher-matching'

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
  /** Dummy-only: when image+caption is sent as single message, caption is text here and file contains voucher. But for dummy we handle caption as forced client name + extractedAmount is sole amount. */
  voucherCaption?: string | null
  voucherExtractedAmount?: number | null
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
  // Dummy-only: keep reference to raw voucher pending for caption forced search
  let voucherPendingItem: { extraction: { monto: number | null; fecha?: string | null }; candidates: unknown[]; sourceMessageId: string } | null = null

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
        // Capture first pending voucher for dummy forced-client flow (caption = client name, amount = extractedAmount sole)
        const vouWithPending = vou as { pending?: { extraction: { monto: number | null }; candidates: unknown[]; sourceMessageId: string }[] } | null
        if (vouWithPending?.pending && vouWithPending.pending.length > 0) {
          // Filter out empty candidates stale pending (crossover fix — dummy only)
          const validPending = vouWithPending.pending.filter((p) => Array.isArray(p.candidates) && p.candidates.length > 0)
          if (validPending.length !== vouWithPending.pending.length && admin) {
            // Prune empty candidates pending — dummy-only crossover fix
            const pruned = { ...vouWithPending, pending: validPending, pendingTexts: (vouWithPending as { pendingTexts?: unknown[] }).pendingTexts || [] }
            await saveVoucherContext(admin!, dummy.conversationId, pruned as never)
            logs.push({ step: 'botbeta_prune_empty_voucher_pending', data: { before: vouWithPending.pending.length, after: validPending.length } })
            // Update local refs
            voucherCtx = pruned
            voucherPendingItem = validPending[0] || null
          } else {
            voucherPendingItem = vouWithPending.pending[0] || null
          }
        }
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

  // ── Dummy-only: image+caption voucher forced client flow ──
  // When caption (text) comes together with voucher (single message imagen+texto), use caption as forced client name
  // and extractedAmount as sole amount. If single message has both, args.voucherCaption contains caption, args.voucherExtractedAmount is monto.
  // For sequential flow (pending voucher awaiting client name), inbound text is caption as client name.
  const forcedCaption = (args.voucherCaption?.trim() || (args.text && voucherPendingItem ? args.text.trim() : null)) || null
  const forcedMonto = args.voucherExtractedAmount ?? voucherPendingItem?.extraction?.monto ?? null

  // If we have a pending voucher (ambiguous) and the inbound text looks like a client name (not a letter A/B selection),
  // perform forced client search in dummy only — amount is always extractedAmount.
  const isLetterSelection = /^[a-zA-Z]\s*$/.test(text.trim()) || /^[a-zA-Z](\s*,\s*[a-zA-Z])+\s*$/.test(text.trim())
  const looksLikeClientName = forcedCaption && forcedCaption.length >= 3 && !isLetterSelection && /[a-zA-Z]{2,}/.test(forcedCaption)

  if (voucherPendingItem && looksLikeClientName && forcedMonto && forcedMonto > 0) {
    try {
      const tolerancia = getMontoTolerancia(forcedMonto) ?? 50
      logs.push({ step: 'botbeta_voucher_forced_search', data: { caption: forcedCaption, monto: forcedMonto, tolerancia } })
      const forcedResult = await matchVoucherByName({
        nombre_cliente: forcedCaption,
        monto: forcedMonto,
        tolerancia,
      })
      const forcedCandidates = forcedResult.invoice_candidates || []
      logs.push({ step: 'botbeta_voucher_forced_result', data: { candidates: forcedCandidates.map((c) => ({ factura: c.numero_factura, cliente: c.cliente_nombre, saldo: c.saldo_pendiente, score: c.score })) } })

      if (forcedCandidates.length === 0) {
        const reply = `Busqué "${forcedCaption}" pero no encontré facturas con saldo cercano a $${forcedMonto.toLocaleString('es-AR')}. Probá con el nombre exacto del cliente.`
        const allLogs = [...logs, { step: 'assistant_response', data: { reply_preview: reply.slice(0, 200) } }]
        return {
          reply,
          dispatchedTo: 'voucher',
          dispatchReason: 'forced_client_no_match',
          extraction: extraction,
          toolResults: { forcedCaption, forcedMonto, forcedCandidates: [] },
          toolLogs: [{ tool: `matchVoucherByName(${forcedCaption})`, duration_ms: 0, resultCount: 0 }],
          knowledge: [],
          logs: allLogs,
          dummyConversationId,
        }
      }

      if (forcedCandidates.length === 1) {
        const inv = forcedCandidates[0]
        const restante = inv.saldo_pendiente - forcedMonto
        const reply = inv.cliente_nombre
          ? `Confirmado (dummy). Pago de $${forcedMonto.toLocaleString('es-AR')} para ${inv.cliente_nombre} — Factura ${inv.numero_factura}${restante > 0 ? ` (queda $${restante.toLocaleString('es-AR')})` : restante < 0 ? ` (excede saldo)` : ''}. [dryRun, no registra]`
          : `Confirmado (dummy). Pago de $${forcedMonto.toLocaleString('es-AR')} para factura ${inv.numero_factura}. [dryRun]`
        const allLogs = [...logs, { step: 'assistant_response', data: { reply_preview: reply.slice(0, 200) } }]
        return {
          reply,
          dispatchedTo: 'voucher',
          dispatchReason: 'forced_client_matched',
          extraction: extraction,
          toolResults: { forcedCaption, forcedMonto, forcedCandidates },
          toolLogs: [{ tool: `matchVoucherByName(${forcedCaption})`, duration_ms: 0, resultCount: 1 }],
          knowledge: [],
          logs: allLogs,
          dummyConversationId,
        }
      }

      // Multiple invoices -> show list as ambiguous, same UX as production
      const clientesUnicos = new Set(forcedCandidates.map((c) => c.cliente_nombre)).size
      const intro = `Recibimos un pago de $${forcedMonto.toLocaleString('es-AR')} para "${forcedCaption}". Hay ${clientesUnicos} clientes/facturas posibles:\n\n`
      const lines = forcedCandidates.map((c, i) => `${String.fromCharCode(65 + i)}. ${c.cliente_nombre} — Factura ${c.numero_factura} — Saldo: $${c.saldo_pendiente.toLocaleString('es-AR')}`).join('\n')
      const reply = `${intro}${lines}\n\nRespondé con la letra (A, B...) [dummy dryRun]`
      const allLogs = [...logs, { step: 'assistant_response', data: { reply_preview: reply.slice(0, 300) } }]
      return {
        reply,
        dispatchedTo: 'voucher',
        dispatchReason: 'forced_client_ambiguous',
        extraction: extraction,
        toolResults: { forcedCaption, forcedMonto, forcedCandidates },
        toolLogs: [{ tool: `matchVoucherByName(${forcedCaption})`, duration_ms: 0, resultCount: forcedCandidates.length }],
        knowledge: [],
        logs: allLogs,
        dummyConversationId,
      }
    } catch (err) {
      logs.push({ step: 'botbeta_voucher_forced_error', data: { error: err instanceof Error ? err.message : String(err) } })
    }
  }

  // Single-message image+caption (no pending yet) — also handle caption as forced client in dummy
  // If text looks like "FAC 00123 Acme SRL" or "Acme SRL" and intent is voucher with monto, try forced search pre-assistant
  const captionInSameMessage = args.voucherCaption && args.voucherExtractedAmount
  if (captionInSameMessage && !voucherPendingItem && extraction?.intent === 'voucher' && looksLikeClientName) {
    try {
      const tolerancia = getMontoTolerancia(args.voucherExtractedAmount!) ?? 50
      const forcedResult = await matchVoucherByName({
        nombre_cliente: args.voucherCaption!.trim(),
        monto: args.voucherExtractedAmount!,
        tolerancia,
      })
      const forcedCandidates = forcedResult.invoice_candidates || []
      if (forcedCandidates.length > 0) {
        const intro = `Recibimos un pago de $${args.voucherExtractedAmount!.toLocaleString('es-AR')} para "${args.voucherCaption!.trim()}".\n\n`
        const lines = forcedCandidates.slice(0, 15).map((c, i) => `${String.fromCharCode(65 + i)}. ${c.cliente_nombre} — Factura ${c.numero_factura} — Saldo: $${c.saldo_pendiente.toLocaleString('es-AR')}`).join('\n')
        const reply = forcedCandidates.length === 1
          ? `Confirmado (dummy). Pago de $${args.voucherExtractedAmount!.toLocaleString('es-AR')} para ${forcedCandidates[0].cliente_nombre} — Factura ${forcedCandidates[0].numero_factura}. [dryRun]`
          : `${intro}${lines}\n\nRespondé con la letra (A, B...) [dummy dryRun]`
        const allLogs = [...logs, { step: 'botbeta_voucher_caption_forced', data: { caption: args.voucherCaption, monto: args.voucherExtractedAmount, candidates: forcedCandidates.length } }]
        return {
          reply,
          dispatchedTo: 'voucher',
          dispatchReason: forcedCandidates.length === 1 ? 'forced_client_matched' : 'forced_client_ambiguous',
          extraction: extraction,
          toolResults: { forcedCaption: args.voucherCaption, forcedMonto: args.voucherExtractedAmount, forcedCandidates },
          toolLogs: [{ tool: `matchVoucherByName(${args.voucherCaption})`, duration_ms: 0, resultCount: forcedCandidates.length }],
          knowledge: [],
          logs: allLogs,
          dummyConversationId,
        }
      }
    } catch (err) {
      logs.push({ step: 'botbeta_voucher_caption_error', data: { error: err instanceof Error ? err.message : String(err) } })
    }
  }

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
