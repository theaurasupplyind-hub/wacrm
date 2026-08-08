import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { engineSendText, engineSendInteractiveButtons } from '@/lib/flows/meta-send'
import { parseExpense } from './parse-expense'
import { fuzzyMatchExpense, resolveExpenseCategory } from './fuzzy-match'
import { executeExpense } from './execute-expense'
import { buildExpenseConfirmation, buildExpensePreview } from './confirm-expense'
import { transcribeExpense } from './transcribe-expense'
import { extractExpenseData } from './extract-expense'
import { loadExpenseContext, saveExpenseContext, clearExpenseContext } from './context'
import type { ParsedExpense, ExpenseFuzzyMatch, ExpenseExecutionResult, PaymentSplit, ExpenseContextState } from './types'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { UnifiedExtraction } from '@/lib/bot-llm/types'

export const EXP_CONFIRM_ID = 'exp_confirm'
export const EXP_CORRECT_ID = 'exp_correct'
export const EXP_CANCEL_ID = 'exp_cancel'

export interface ProcessExpenseMessageArgs {
  db: SupabaseClient
  messageType: 'text' | 'audio' | 'image' | 'document'
  text?: string | null
  mediaId?: string | null
  mimeType?: string | null
  /** WhatsApp message ID (Meta), para correlacionar con la tabla messages. */
  messageId?: string | null
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
  const parts = fecha.split(/[\/\-]/)
  if (parts.length === 3) {
    const [d, m, y] = parts
    if (y.length === 4) return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
    return `${y.padStart(4, '0')}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  return todaysDate()
}

async function createSaldoExpense(
  parsed: ParsedExpense,
  match: ExpenseFuzzyMatch,
  result: ExpenseExecutionResult,
  args: ProcessExpenseMessageArgs,
  mediaUrl: string | null,
) {
  if (!parsed.saldo || parsed.saldo.length === 0 || !result.expenseId || !match.providerId) return
  const saldoAmount = parsed.saldo.reduce((sum: number, s: PaymentSplit) => sum + s.amount, 0)
  const compraCategory = await resolveExpenseCategory('Compra a proveedor')
  if (!compraCategory.categoryId) return
  const saldoParsed: ParsedExpense = {
    amount: saldoAmount,
    description: `Saldo pendiente${match.providerName ? ` de ${match.providerName}` : ''}`,
    category: 'Compra a proveedor',
    provider: parsed.provider,
    employee: null,
    payment_method: parsed.saldo.length === 1 ? parsed.saldo[0].payment_method : null,
    payments: parsed.saldo,
    reference: null,
    date: parsed.date || new Date().toISOString().slice(0, 10),
    isExpenseIntent: true,
    raw: parsed.raw,
  }
  const saldoMatch: ExpenseFuzzyMatch = {
    categoryId: compraCategory.categoryId,
    categoryName: 'Compra a proveedor',
    categoryWasCreated: compraCategory.created,
    providerId: match.providerId,
    providerName: match.providerName,
    employeeId: null,
    employeeName: null,
  }
  const saldoResult = await executeExpense(saldoParsed, saldoMatch, {
    source: 'whatsapp',
    createdByContactId: parseInt(args.contactId, 10) || null,
    mediaUrl,
    mediaId: args.mediaId || null,
  })
  if (saldoResult.expenseId) {
    result.saldoResult = saldoResult
  }
}

async function sendTextResponse(args: ProcessExpenseMessageArgs, text: string) {
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
}

interface ExpenseLogEntry {
  status: string
  rawText?: string | null
  amount?: number | null
  category?: string | null
  provider?: string | null
  employee?: string | null
  paymentMethod?: string | null
  reference?: string | null
  extractorSource?: string | null
  confianza?: string | null
  matchedExpenseId?: number | null
  errorMessage?: string | null
  debug?: Record<string, unknown>
}

/**
 * Auditoría de cada evento del flujo de gastos en `expense_extractions`
 * (migración 037 + columnas debug_info de la 045). Fire-and-forget: nunca
 * debe romper el procesamiento del gasto.
 */
async function logExpenseExtraction(args: ProcessExpenseMessageArgs, entry: ExpenseLogEntry) {
  try {
    await args.db.from('expense_extractions').insert({
      message_id: args.messageId || args.mediaId || null,
      contact_id: args.contactId,
      conversation_id: args.conversationId,
      raw_text: entry.rawText ?? null,
      extracted_amount: entry.amount ?? null,
      extracted_category: entry.category ?? null,
      extracted_provider: entry.provider ?? null,
      extracted_employee: entry.employee ?? null,
      extracted_payment_method: entry.paymentMethod ?? null,
      extracted_reference: entry.reference ?? null,
      match_status: entry.status,
      matched_expense_id: entry.matchedExpenseId ?? null,
      error_message: entry.errorMessage ?? null,
      extractor_source: entry.extractorSource ?? null,
      confianza: entry.confianza ?? null,
      debug_info: entry.debug ?? null,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('relation') && msg.includes('does not exist')) {
      console.error('[expense-log] TABLE MISSING — run migration 037_expense_extractions.sql in Supabase')
    } else {
      console.error('[expense-log] Failed to save extraction record:', msg)
    }
  }
}

function parseFloatSafe(reply: string): number | null {
  const cleaned = reply.replace(/[^0-9,.]/g, '').replace(',', '.')
  const num = parseFloat(cleaned)
  return Number.isFinite(num) && num > 0 ? num : null
}

async function handleCollectingReply(
  args: ProcessExpenseMessageArgs,
  ctx: ExpenseContextState,
): Promise<ProcessExpenseResult> {
  const pending = { ...ctx.pendingExpense! } as ParsedExpense
  const reply = (args.text || '').trim()

  if (!reply) {
    return { handled: true, text: 'No entendí. ¿Podés repetirlo?' }
  }

  if (ctx.missingField === 'amount') {
    const num = parseFloatSafe(reply)
    if (!num) {
      await saveExpenseContext(args.db, args.conversationId, { ...ctx })
      return { handled: true, text: 'Sigo sin entender el monto. Escribí solo el número (ej: 5000).' }
    }
    pending.amount = num
  } else if (ctx.missingField === 'category') {
    pending.category = reply
  } else if (!ctx.missingField) {
    // Viene de ✏️ Corregir: el usuario elige qué campo tocar.
    const cleaned = reply.toLowerCase()
    if (cleaned === 'cancelar' || cleaned === 'no') {
      await clearExpenseContext(args.db, args.conversationId)
      return { handled: true, text: 'Listo, no guardé el gasto. 👍' }
    }
    if (cleaned.includes('monto') || cleaned.includes('importe') || cleaned.includes('plata')) {
      await saveExpenseContext(args.db, args.conversationId, { ...ctx, missingField: 'amount' })
      return { handled: true, text: '¿Cuál es el monto correcto? (solo números)' }
    }
    const num = parseFloatSafe(reply)
    if (num) {
      pending.amount = num
    } else {
      pending.category = reply
    }
  }

  const match = await fuzzyMatchExpense(pending)

  if (!match.categoryId) {
    await saveExpenseContext(args.db, args.conversationId, { ...ctx, pendingExpense: pending, pendingMatch: match })
    return { handled: true, text: 'No encontré esa categoría. ¿Podés intentar con otro nombre?' }
  }

  const result = await executeExpense(pending, match, {
    source: 'whatsapp',
    createdByContactId: parseInt(args.contactId, 10) || null,
  })

  if (result.error || !result.expenseId) {
    await logExpenseExtraction(args, {
      status: 'error',
      rawText: pending.raw,
      amount: pending.amount,
      category: pending.category,
      provider: pending.provider,
      employee: pending.employee,
      paymentMethod: pending.payment_method,
      extractorSource: pending.extractorSource,
      confianza: pending.confianza,
      errorMessage: result.error || 'No se pudo guardar el gasto.',
      debug: { flow: 'collecting_reply', match },
    })
    await clearExpenseContext(args.db, args.conversationId)
    return { handled: true, error: result.error, text: result.error || 'No se pudo guardar el gasto.' }
  }

  await createSaldoExpense(pending, match, result, args, null)

  await logExpenseExtraction(args, {
    status: 'confirmed',
    rawText: pending.raw,
    amount: pending.amount,
    category: pending.category,
    provider: pending.provider,
    employee: pending.employee,
    paymentMethod: pending.payment_method,
    extractorSource: pending.extractorSource,
    confianza: pending.confianza,
    matchedExpenseId: result.expenseId,
    debug: { flow: 'collecting_reply', match },
  })

  await clearExpenseContext(args.db, args.conversationId)

  const text = buildExpenseConfirmation(result)
  await sendTextResponse(args, text)
  return { handled: true, expenseId: result.expenseId, text }
}

/**
 * Determina si un gasto parseado necesita confirmación antes de guardarse:
 * - el parser no pudo anclar el monto a una palabra de dinero (dudoso);
 * - la categoría fue creada automáticamente (nueva);
 * - el proveedor/empleado no matcheó con ninguna entidad conocida.
 */
function isExpenseAmbiguous(parsed: ParsedExpense, match: ExpenseFuzzyMatch): boolean {
  if (parsed.amountAmbiguous) return true
  if (match.categoryWasCreated) return true
  if (parsed.provider && !match.providerId && !match.employeeId) return true
  if (parsed.employee && !match.employeeId) return true
  return false
}

async function sendExpenseConfirmButtons(args: ProcessExpenseMessageArgs, text: string) {
  try {
    await engineSendInteractiveButtons({
      accountId: args.accountId,
      userId: args.userId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      bodyText: text,
      buttons: [
        { id: EXP_CONFIRM_ID, title: '✅ Confirmar' },
        { id: EXP_CORRECT_ID, title: '✏️ Corregir' },
        { id: EXP_CANCEL_ID, title: '❌ Cancelar' },
      ],
    })
  } catch (err) {
    console.error('[expense] confirm buttons error:', err)
    await sendTextResponse(args, text)
  }
}

async function executeAndConfirmExpense(
  args: ProcessExpenseMessageArgs,
  parsed: ParsedExpense,
  match: ExpenseFuzzyMatch,
  mediaUrl: string | null,
): Promise<ProcessExpenseResult> {
  const result = await executeExpense(parsed, match, {
    source: 'whatsapp',
    createdByContactId: parseInt(args.contactId, 10) || null,
    mediaUrl,
    mediaId: args.mediaId || null,
  })

  await createSaldoExpense(parsed, match, result, args, mediaUrl)

  // Auditoría
  await logExpenseExtraction(args, {
    status: result.error ? 'error' : 'confirmed',
    rawText: parsed.raw,
    amount: parsed.amount,
    category: parsed.category,
    provider: parsed.provider,
    employee: parsed.employee,
    paymentMethod: parsed.payment_method,
    reference: parsed.reference,
    extractorSource: parsed.extractorSource,
    confianza: parsed.confianza,
    matchedExpenseId: result.expenseId,
    errorMessage: result.error || undefined,
    debug: { match, result, media_url: mediaUrl },
  })

  const text = buildExpenseConfirmation(result)
  await sendTextResponse(args, text)
  return { handled: true, expenseId: result.expenseId, text }
}

/**
 * Maneja el tap a los botones de confirmación del gasto:
 * ✅ Confirmar → ejecuta + audita + confirma.
 * ✏️ Corregir → vuelve a `collecting` y pregunta qué campo tocar.
 * ❌ Cancelar (o cualquier otra reply) → limpia el contexto.
 */
export async function processExpenseConfirmReply(
  args: ProcessExpenseMessageArgs,
  replyId: string,
): Promise<ProcessExpenseResult> {
  const ctx = await loadExpenseContext(args.db, args.conversationId)
  if (ctx.stage !== 'confirming' || !ctx.pendingExpense) {
    return { handled: false }
  }

  const parsed = ctx.pendingExpense
  const match = ctx.pendingMatch

  if (replyId === EXP_CONFIRM_ID) {
    if (!match) {
      await logExpenseExtraction(args, {
        status: 'error',
        rawText: parsed.raw,
        amount: parsed.amount,
        category: parsed.category,
        extractorSource: parsed.extractorSource,
        confianza: parsed.confianza,
        errorMessage: 'No se pudo recuperar el gasto pendiente.',
        debug: { flow: 'confirm_reply', replyId },
      })
      await clearExpenseContext(args.db, args.conversationId)
      return { handled: true, text: 'No pude recuperar el gasto pendiente. Escribílo de nuevo, por favor.' }
    }
    await clearExpenseContext(args.db, args.conversationId)
    return executeAndConfirmExpense(args, parsed, match, null)
  }

  if (replyId === EXP_CORRECT_ID) {
    await saveExpenseContext(args.db, args.conversationId, {
      ...ctx,
      stage: 'collecting',
      awaitingConfirmation: false,
      missingField: null,
    })
    await logExpenseExtraction(args, {
      status: 'collecting',
      rawText: parsed.raw,
      amount: parsed.amount,
      category: parsed.category,
      provider: parsed.provider,
      employee: parsed.employee,
      paymentMethod: parsed.payment_method,
      extractorSource: parsed.extractorSource,
      confianza: parsed.confianza,
      debug: { flow: 'confirm_reply_correct', replyId, correcting: true },
    })
    const msg = '¿Qué querés corregir? Escribí el monto (solo números) o la categoría correcta.'
    await sendTextResponse(args, msg)
    return { handled: true, text: msg }
  }

  await logExpenseExtraction(args, {
    status: 'cancelled',
    rawText: parsed.raw,
    amount: parsed.amount,
    category: parsed.category,
    provider: parsed.provider,
    employee: parsed.employee,
    paymentMethod: parsed.payment_method,
    extractorSource: parsed.extractorSource,
    confianza: parsed.confianza,
    debug: { flow: 'confirm_reply_cancel', replyId },
  })
  await clearExpenseContext(args.db, args.conversationId)
  const msg = 'Listo, no guardé el gasto. 👍'
  await sendTextResponse(args, msg)
  return { handled: true, text: msg }
}

export async function processExpenseMessage(
  args: ProcessExpenseMessageArgs,
  extraction?: UnifiedExtraction,
): Promise<ProcessExpenseResult> {
  const ctx = await loadExpenseContext(args.db, args.conversationId)
  if (ctx.stage === 'collecting' && ctx.pendingExpense && args.messageType === 'text') {
    return handleCollectingReply(args, ctx)
  }

  let parsed: ParsedExpense | null = null
  let mediaUrl: string | null = null

  try {
    if (args.messageType === 'text' && args.text) {
      const regexParsed = parseExpense(args.text)
      if (extraction && extraction.intent === 'gasto') {
        parsed = {
          amount: extraction.monto,
          description: regexParsed.description,
          category: extraction.categoria,
          provider: extraction.proveedor,
          employee: extraction.empleado_gasto,
          payment_method: extraction.metodo_pago,
          // Merge con regex: conserva split payments y saldo que el LLM no modela.
          payments: regexParsed.payments || undefined,
          saldo: regexParsed.saldo || undefined,
          reference: regexParsed.reference,
          date: extraction.fecha || regexParsed.date,
          isExpenseIntent: true,
          amountAmbiguous: extraction.dudoso || regexParsed.amountAmbiguous,
          raw: args.text,
          extractorSource: extraction.extractor_source,
          confianza: extraction.confianza,
        }
      } else {
        parsed = regexParsed
        parsed.extractorSource = 'regex'
      }
    } else if (args.messageType === 'audio' && args.mediaId && args.mimeType) {
      const mediaInfo = await getMediaUrl({ mediaId: args.mediaId, accessToken: args.accessToken })
      const audio = await downloadMedia({ downloadUrl: mediaInfo.url, accessToken: args.accessToken })
      const transcript = await transcribeExpense(audio.buffer, audio.contentType)
      parsed = parseExpense(transcript)
      parsed.extractorSource = 'whisper_regex'
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
        extractorSource: 'multimodal',
      }
    }

    if (!parsed || !parsed.isExpenseIntent) {
      await logExpenseExtraction(args, {
        status: 'not_handled',
        rawText: args.text || args.mediaId || null,
        extractorSource: parsed?.extractorSource,
        confianza: parsed?.confianza,
        debug: { messageType: args.messageType },
      })
      return { handled: false }
    }

    // Multi-turn: si falta monto, guardar contexto y preguntar
    if (!parsed.amount || parsed.amount <= 0) {
      await saveExpenseContext(args.db, args.conversationId, {
        stage: 'collecting',
        pendingExpense: parsed,
        missingField: 'amount',
      })
      await logExpenseExtraction(args, {
        status: 'collecting',
        rawText: parsed.raw,
        amount: parsed.amount,
        category: parsed.category,
        provider: parsed.provider,
        employee: parsed.employee,
        paymentMethod: parsed.payment_method,
        extractorSource: parsed.extractorSource,
        confianza: parsed.confianza,
        debug: { missingField: 'amount', extraction },
      })
      const msg = 'No detecté el monto. ¿Cuánto fue?'
      await sendTextResponse(args, msg)
      return { handled: true, text: msg }
    }

    const match = await fuzzyMatchExpense(parsed)

    // Multi-turn: si falta categoría, guardar contexto y preguntar
    if (!match.categoryId) {
      await saveExpenseContext(args.db, args.conversationId, {
        stage: 'collecting',
        pendingExpense: parsed,
        pendingMatch: match,
        missingField: 'category',
      })
      await logExpenseExtraction(args, {
        status: 'collecting',
        rawText: parsed.raw,
        amount: parsed.amount,
        category: parsed.category,
        provider: parsed.provider,
        employee: parsed.employee,
        paymentMethod: parsed.payment_method,
        extractorSource: parsed.extractorSource,
        confianza: parsed.confianza,
        debug: { missingField: 'category', match },
      })
      const msg = 'No entendí la categoría. ¿Para qué fue el gasto? (ej: luz, alquiler, insumos)'
      await sendTextResponse(args, msg)
      return { handled: true, text: msg }
    }

    // Ambigüedad → confirmación interactiva en lugar de auto-guardar
    if (isExpenseAmbiguous(parsed, match)) {
      await saveExpenseContext(args.db, args.conversationId, {
        stage: 'confirming',
        pendingExpense: parsed,
        pendingMatch: match,
        awaitingConfirmation: true,
      })
      const preview = buildExpensePreview(parsed)
      await logExpenseExtraction(args, {
        status: 'ambiguous',
        rawText: parsed.raw,
        amount: parsed.amount,
        category: parsed.category,
        provider: parsed.provider,
        employee: parsed.employee,
        paymentMethod: parsed.payment_method,
        extractorSource: parsed.extractorSource,
        confianza: parsed.confianza,
        debug: { match, preview, reason: {
          amountAmbiguous: parsed.amountAmbiguous,
          categoryWasCreated: match.categoryWasCreated,
          providerUnresolved: !!parsed.provider && !match.providerId && !match.employeeId,
          employeeUnresolved: !!parsed.employee && !match.employeeId,
        } },
      })
      await sendExpenseConfirmButtons(args, preview)
      return { handled: true, text: preview }
    }

    return executeAndConfirmExpense(args, parsed, match, mediaUrl)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[expense] process error:', msg)
    await logExpenseExtraction(args, {
      status: 'error',
      rawText: args.text || args.mediaId || null,
      extractorSource: parsed?.extractorSource,
      confianza: parsed?.confianza,
      errorMessage: msg,
      debug: { messageType: args.messageType },
    })
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