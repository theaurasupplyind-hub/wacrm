import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { engineSendText } from '@/lib/flows/meta-send'
import { parseExpense } from './parse-expense'
import { fuzzyMatchExpense } from './fuzzy-match'
import { executeExpense } from './execute-expense'
import { buildExpenseConfirmation } from './confirm-expense'
import { transcribeExpense } from './transcribe-expense'
import { extractExpenseData } from './extract-expense'
import { loadExpenseContext, saveExpenseContext, clearExpenseContext } from './context'
import type { ParsedExpense, ExpenseContextState } from './types'
import type { SupabaseClient } from '@supabase/supabase-js'

export interface ProcessExpenseMessageArgs {
  db: SupabaseClient
  messageType: 'text' | 'audio' | 'image' | 'document'
  text?: string | null
  mediaId?: string | null
  mimeType?: string | null
  accessToken: string
  senderPhone: string
  senderName: string
  accountId: string
  userId: string
  conversationId: string
  contactId: string
}

export interface ProcessExpenseResult {
  handled: boolean
  expenseId?: number | null
  text?: string
  error?: string
}

function todaysDate(): string {
  return new Date().toISOString().slice(0, 10)
}

function parseDateFromExtracted(fecha: string | null): string {
  if (!fecha) return todaysDate()
  // Soporta "15/03/2026" o "15-03-2026"
  const parts = fecha.split(/[\/\-]/)
  if (parts.length === 3) {
    const [d, m, y] = parts
    if (y.length === 4) return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
    return `${y.padStart(4, '0')}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  return todaysDate()
}

export async function processExpenseMessage(
  args: ProcessExpenseMessageArgs,
): Promise<ProcessExpenseResult> {
  let parsed: ParsedExpense | null = null
  let mediaUrl: string | null = null

  try {
    if (args.messageType === 'text' && args.text) {
      parsed = parseExpense(args.text)
    } else if (args.messageType === 'audio' && args.mediaId && args.mimeType) {
      const mediaInfo = await getMediaUrl({ mediaId: args.mediaId, accessToken: args.accessToken })
      const audio = await downloadMedia({ downloadUrl: mediaInfo.url, accessToken: args.accessToken })
      const transcript = await transcribeExpense(audio.buffer, audio.contentType)
      parsed = parseExpense(transcript)
    } else if ((args.messageType === 'image' || args.messageType === 'document') && args.mediaId && args.mimeType) {
      const mediaInfo = await getMediaUrl({ mediaId: args.mediaId, accessToken: args.accessToken })
      const file = await downloadMedia({ downloadUrl: mediaInfo.url, accessToken: args.accessToken })
      const base64 = Buffer.from(file.buffer).toString('base64')
      const extracted = await extractExpenseData({ base64, mimeType: args.mimeType })
      mediaUrl = `/api/whatsapp/media/${args.mediaId}`
      parsed = {
        amount: extracted.monto,
        description: extracted.descripcion || 'Gasto registrado por comprobante',
        category: extracted.categoria,
        provider: extracted.proveedor,
        employee: extracted.empleado,
        payment_method: extracted.metodo_pago,
        reference: extracted.referencia,
        date: parseDateFromExtracted(extracted.fecha),
        isExpenseIntent: true,
        raw: JSON.stringify(extracted),
      }
    }

    if (!parsed || !parsed.isExpenseIntent) {
      return { handled: false }
    }

    if (!parsed.amount || parsed.amount <= 0) {
      return {
        handled: true,
        text: 'No detecté un monto válido. ¿Podés repetir el gasto con el monto?',
      }
    }

    const match = await fuzzyMatchExpense(parsed)
    const result = await executeExpense(parsed, match, {
      source: 'whatsapp',
      createdByContactId: parseInt(args.contactId, 10) || null,
      mediaUrl,
      mediaId: args.mediaId || null,
    })

    // Auditoría
    try {
      await args.db.from('expense_extractions').insert({
        message_id: args.mediaId || undefined,
        contact_id: args.contactId,
        conversation_id: args.conversationId,
        raw_text: parsed.raw,
        extracted_amount: parsed.amount,
        extracted_category: parsed.category,
        extracted_provider: parsed.provider,
        extracted_employee: parsed.employee,
        extracted_payment_method: parsed.payment_method,
        extracted_reference: parsed.reference,
        match_status: result.error ? 'error' : 'confirmed',
        matched_expense_id: result.expenseId,
        error_message: result.error || undefined,
      })
    } catch (auditErr) {
      console.error('[expense] audit insert error:', auditErr)
    }

    const text = buildExpenseConfirmation(result)

    try {
      await engineSendText({
        accountId: args.accountId,
        userId: args.userId,
        conversationId: args.conversationId,
        contactId: args.contactId,
        text,
      })
    } catch (sendErr) {
      console.error('[expense] send error:', sendErr)
    }

    return {
      handled: true,
      expenseId: result.expenseId,
      text,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[expense] process error:', msg)
    return {
      handled: true,
      error: msg,
      text: '❌ No pude procesar el gasto. Intentá de nuevo o contactá al administrador.',
    }
  }
}

export { loadExpenseContext, saveExpenseContext, clearExpenseContext, parseExpense }
export { looksLikeExpense } from './parse-expense'
export type { ParsedExpense, ExpenseContextState }
