/**
 * Persistencia de trazas del bot.
 *
 * Fire-and-forget, tolerante a tabla ausente (mismo patrón que
 * `voucher-pipeline.saveAttempt`). Upsert por `message_id`: los distintos
 * productores (webhook/router, voucher, assistant) enriquecen la MISMA
 * traza a medida que el mensaje avanza por el flujo.
 */

import { supabaseAdmin } from '@/lib/ai/admin-client'
import { BotTraceSchema, rowToBotTrace, type BotTrace } from './schema'
import { mergeBotTraces } from './merge'

export async function recordBotTrace(trace: BotTrace): Promise<void> {
  try {
    const parsed = BotTraceSchema.parse(trace)
    const db = supabaseAdmin()

    // Append-only: si la traza ya existe, se enriquece en vez de pisarla.
    let toSave = parsed
    const { data: existing } = await db
      .from('bot_traces')
      .select('*')
      .eq('message_id', parsed.messageId)
      .maybeSingle()
    if (existing) {
      const existingTrace = rowToBotTrace(existing as Record<string, unknown>)
      if (existingTrace) toSave = mergeBotTraces(existingTrace, parsed)
    }

    const { error } = await db.from('bot_traces').upsert(
      {
        message_id: toSave.messageId,
        conversation_id: toSave.conversationId ?? null,
        contact_id: toSave.contactId ?? null,
        account_id: toSave.accountId ?? null,
        source: toSave.source ?? null,
        raw_text: toSave.rawText ?? null,
        status: toSave.status,
        path: toSave.path,
        steps: toSave.steps,
        error_message: toSave.errorMessage ?? null,
      },
      { onConflict: 'message_id' },
    )

    if (error) {
      if (
        error.message.includes('relation') &&
        error.message.includes('does not exist')
      ) {
        console.error(
          '[bot-trace] TABLE MISSING — run migration 048_bot_traces.sql in Supabase',
        )
      } else {
        console.error('[bot-trace] upsert failed:', error.message)
      }
    }
  } catch (err) {
    console.error(
      '[bot-trace] record failed:',
      err instanceof Error ? err.message : String(err),
    )
  }
}
