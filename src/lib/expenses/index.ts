import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { engineSendText, engineSendInteractiveButtons } from '@/lib/flows/meta-send'
import { updateExpense } from '@/lib/facbal/client'
import { parseExpense } from './parse-expense'
import { fuzzyMatchExpense, resolveExpenseCategory } from './fuzzy-match'
import { executeExpense } from './execute-expense'
import { buildExpenseConfirmation, buildExpensePreview } from './confirm-expense'
import { transcribeExpense } from './transcribe-expense'
import { extractExpenseData } from './extract-expense'
import { loadExpenseContext, saveExpenseContext, clearExpenseContext } from './context'
import { isCategoryCorrectionCommand } from './command'
import type { ParsedExpense, ExpenseFuzzyMatch, ExpenseExecutionResult, PaymentSplit, ExpenseContextState } from './types'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { UnifiedExtraction, MultiExpenseItem } from '@/lib/bot-llm/types'

export const EXP_CONFIRM_ID = 'exp_confirm'
export const EXP_CORRECT_ID = 'exp_correct'
export const EXP_CANCEL_ID = 'exp_cancel'

export const EXP_MULTI_CONFIRM_ID = 'exp_multi_confirm'
export const EXP_MULTI_EDIT_ID = 'exp_multi_edit'
export const EXP_MULTI_CANCEL_ID = 'exp_multi_cancel'

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
    tipoGasto: 'compra',
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
  await rememberLastExpense(args.db, args.conversationId, result)

  const text = buildExpenseConfirmation(result)
  await sendTextResponse(args, text)
  return { handled: true, expenseId: result.expenseId, text }
}

/**
 * Recuerda el último gasto confirmado para poder corregirlo después por texto.
 * Se persiste en expense_context (sin stage pendiente, para no interferir con
 * los multi-turnos activos).
 */
async function rememberLastExpense(
  db: SupabaseClient,
  conversationId: string,
  result: ExpenseExecutionResult,
) {
  if (!result.expenseId) return
  await saveExpenseContext(db, conversationId, {
    lastExpenseId: result.expenseId,
    lastExpenseAmount: result.amount,
    lastCategoryName: result.categoryName,
  })
}

/**
 * Aplica la corrección de categoría a un gasto ya confirmado: matchea la nueva
 * categoría y la persiste vía PUT /expenses/{id}. Devuelve true si se corrigió.
 */
async function applyCategoryCorrection(
  args: ProcessExpenseMessageArgs,
  ctx: ExpenseContextState,
  categoryText: string,
): Promise<ProcessExpenseResult> {
  const expenseId = ctx.correctingCategoryExpenseId ?? ctx.lastExpenseId
  if (!expenseId) {
    await clearExpenseContext(args.db, args.conversationId)
    return {
      handled: true,
      text: 'No encontré un gasto reciente para corregir. Escribí el gasto de nuevo, por favor.',
    }
  }

  let category: Awaited<ReturnType<typeof resolveExpenseCategory>>
  try {
    category = await resolveExpenseCategory(categoryText)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[expense] category correction resolve error:', msg)
    await logExpenseExtraction(args, {
      status: 'error',
      rawText: args.text || null,
      matchedExpenseId: expenseId,
      errorMessage: msg,
      debug: { flow: 'category_correction', category: categoryText },
    })
    return { handled: true, text: '❌ No pude actualizar la categoría. Intentá de nuevo.' }
  }

  if (!category.categoryId) {
    await saveExpenseContext(args.db, args.conversationId, {
      ...ctx,
      correctingCategory: true,
      correctingCategoryExpenseId: expenseId,
    })
    return { handled: true, text: 'No encontré esa categoría. ¿Podés intentar con otro nombre?' }
  }

  try {
    await updateExpense(expenseId, { category_id: category.categoryId })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[expense] category correction update error:', msg)
    await logExpenseExtraction(args, {
      status: 'error',
      rawText: args.text || null,
      matchedExpenseId: expenseId,
      errorMessage: msg,
      debug: { flow: 'category_correction', category: categoryText },
    })
    return { handled: true, text: '❌ No pude actualizar la categoría. Intentá de nuevo.' }
  }

  await logExpenseExtraction(args, {
    status: 'category_corrected',
    rawText: args.text || null,
    category: category.categoryName,
    matchedExpenseId: expenseId,
    debug: { flow: 'category_correction', categoryId: category.categoryId, ctx },
  })

  await clearExpenseContext(args.db, args.conversationId)

  const parts: string[] = ['✅ Categoría corregida.']
  if (ctx.lastExpenseAmount) {
    parts.push(`💰 $${ctx.lastExpenseAmount.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`)
  }
  parts.push(`📁 ${category.categoryName}`)
  const msg = parts.join('\n')
  await sendTextResponse(args, msg)
  return { handled: true, text: msg }
}

/**
 * Arranca la corrección de categoría por texto. Si el mensaje ya trae la
 * categoría ("la categoría correcta es X") se aplica en un solo turno; si no,
 * pregunta cuál es la correcta.
 */
async function handleCategoryCorrectionStart(
  args: ProcessExpenseMessageArgs,
  ctx: ExpenseContextState,
): Promise<ProcessExpenseResult> {
  const reply = (args.text || '').trim()
  const expenseId = ctx.lastExpenseId
  if (!expenseId) {
    await clearExpenseContext(args.db, args.conversationId)
    return {
      handled: true,
      text: 'No encontré un gasto reciente para corregir. Escribí el gasto de nuevo, por favor.',
    }
  }

  const inline = reply.match(/la\s+categoria\s+(correcta\s+)?es\s+(.+)/i)
  if (inline) {
    return applyCategoryCorrection(args, ctx, inline[2].trim())
  }

  await saveExpenseContext(args.db, args.conversationId, {
    ...ctx,
    stage: 'collecting',
    correctingCategory: true,
    correctingCategoryExpenseId: expenseId,
    pendingExpense: null,
    pendingMultiple: null,
    missingField: null,
  })
  await logExpenseExtraction(args, {
    status: 'collecting',
    rawText: args.text || null,
    matchedExpenseId: expenseId,
    debug: { flow: 'category_correction_start' },
  })
  const msg = '¿Cuál es la categoría correcta? (ej: luz, alquiler, sueldos y salarios)'
  await sendTextResponse(args, msg)
  return { handled: true, text: msg }
}

/**
 * Maneja la respuesta del usuario cuando está corrigiendo la categoría del
 * último gasto (contexto con `correctingCategory`).
 */
async function handleCategoryCorrectionReply(
  args: ProcessExpenseMessageArgs,
  ctx: ExpenseContextState,
): Promise<ProcessExpenseResult> {
  const reply = (args.text || '').trim()
  if (!reply) {
    return { handled: true, text: '¿Cuál es la categoría correcta? (ej: luz, alquiler, sueldos y salarios)' }
  }
  const lower = reply.toLowerCase()
  if (lower === 'cancelar' || lower === 'no') {
    await clearExpenseContext(args.db, args.conversationId)
    const msg = 'Listo, no corregí la categoría. 👍'
    await sendTextResponse(args, msg)
    return { handled: true, text: msg }
  }
  return applyCategoryCorrection(args, ctx, reply)
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
  if (parsed.tipoGasto === 'compra') return true
  if (match.employeeId) return true
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

  if (result.expenseId) {
    await rememberLastExpense(args.db, args.conversationId, result)
  }

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

  // Multi-expense en confirmación → botones propios.
  if (ctx.pendingMultiple && ctx.stage === 'confirming') {
    return handleMultiExpenseConfirmReply(args, ctx, replyId)
  }

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

// ─── Multi-expense (2+ gastos en un solo mensaje) ───

function firstIncompleteMulti(items: MultiExpenseItem[]): { index: number; field: 'amount' | 'category' } | null {
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (!it.amount || it.amount <= 0) return { index: i, field: 'amount' }
    if (!it.category && !it.tipo_gasto) return { index: i, field: 'category' }
  }
  return null
}

function buildMultiExpensePreview(items: MultiExpenseItem[]): string {
  const lines = [`Voy a registrar ${items.length} gastos:`]
  items.forEach((it, i) => {
    const missing: string[] = []
    if (!it.amount || it.amount <= 0) missing.push('monto')
    if (!it.category && !it.tipo_gasto) missing.push('categoría')
    const parts = [
      `💰 $${it.amount ? it.amount.toLocaleString('es-AR', { minimumFractionDigits: 2 }) : '?'}`,
      `📁 ${it.category || (it.tipo_gasto === 'compra' ? 'Compra a proveedor' : it.tipo_gasto === 'pago' ? 'Pago a proveedor' : 'Sin categoría')}`,
    ]
    if (it.provider) parts.push(`🏭 ${it.provider}`)
    lines.push(`${i + 1}. ${parts.join(' · ')}${missing.length ? ` ❓ Falta ${missing.join(', ')}` : ''}`)
  })
  lines.push('')
  lines.push('¿Confirmás todos?')
  return lines.join('\n')
}

async function sendMultiConfirmButtons(args: ProcessExpenseMessageArgs, text: string) {
  try {
    await engineSendInteractiveButtons({
      accountId: args.accountId,
      userId: args.userId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      bodyText: text,
      buttons: [
        { id: EXP_MULTI_CONFIRM_ID, title: '✅ Confirmar todos' },
        { id: EXP_MULTI_EDIT_ID, title: '✏️ Editar' },
        { id: EXP_MULTI_CANCEL_ID, title: '❌ Cancelar' },
      ],
    })
  } catch (err) {
    console.error('[expense] multi confirm buttons error:', err)
    await sendTextResponse(args, text)
  }
}

/**
 * Avanza el flujo multi-expense: si queda algún gasto incompleto (sin monto o
 * sin categoría) pregunta por él; si todos están completos, muestra el preview
 * con los botones [Confirmar todos / Editar / Cancelar].
 */
async function advanceMultiExpense(args: ProcessExpenseMessageArgs): Promise<ProcessExpenseResult> {
  const ctx = await loadExpenseContext(args.db, args.conversationId)
  const items = ctx.pendingMultiple || []
  if (items.length === 0) {
    await clearExpenseContext(args.db, args.conversationId)
    return { handled: true, text: 'No pude recuperar los gastos. Escribílos de nuevo, por favor.' }
  }

  const incomplete = firstIncompleteMulti(items)
  if (incomplete) {
    const { index, field } = incomplete
    const it = items[index]
    await saveExpenseContext(args.db, args.conversationId, {
      ...ctx,
      stage: 'collecting',
      multiMissingIndex: index,
      multiMissingField: field,
    })
    const amountLabel = it.amount ? `$${it.amount.toLocaleString('es-AR', { minimumFractionDigits: 2 })}` : 'sin monto'
    const msg =
      field === 'amount'
        ? `El gasto #${index + 1} no tiene monto. ¿Cuánto fue?`
        : `El gasto #${index + 1} (💰 ${amountLabel}) no tiene categoría. ¿Para qué fue? (ej: luz, alquiler, insumos)`
    await sendTextResponse(args, msg)
    return { handled: true, text: msg }
  }

  // Todos completos → preview + confirmación interactiva.
  await saveExpenseContext(args.db, args.conversationId, {
    ...ctx,
    stage: 'confirming',
    multiMissingIndex: null,
    multiMissingField: null,
    awaitingMultiEditIndex: false,
    multiEditingIndex: null,
  })
  const preview = buildMultiExpensePreview(items)
  await sendMultiConfirmButtons(args, preview)
  return { handled: true, text: preview }
}

async function confirmMultipleExpenses(
  args: ProcessExpenseMessageArgs,
  ctx: ExpenseContextState,
): Promise<ProcessExpenseResult> {
  const items = ctx.pendingMultiple || []
  const saved: ExpenseExecutionResult[] = []
  const errors: string[] = []

  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (!it.amount || it.amount <= 0) {
      errors.push(`#${i + 1} sin monto`)
      continue
    }
    const parsed: ParsedExpense = {
      amount: it.amount,
      description: it.description || it.category || `Gasto ${i + 1}`,
      category: it.category,
      tipoGasto: it.tipo_gasto || 'gasto',
      provider: it.provider,
      employee: it.employee,
      payment_method: it.payment_method,
      reference: null,
      date: it.date || todaysDate(),
      isExpenseIntent: true,
      raw: it.raw || `${it.amount} ${it.category || ''}`.trim(),
      extractorSource: 'llm',
      confianza: 'alta',
    }
    try {
      const match = await fuzzyMatchExpense(parsed)
      if (!match.categoryId) {
        errors.push(`#${i + 1} (${it.category || 'sin categoría'})`)
        continue
      }
      const result = await executeExpense(parsed, match, {
        source: 'whatsapp',
        createdByContactId: parseInt(args.contactId, 10) || null,
      })
      if (result.error || !result.expenseId) {
        errors.push(`#${i + 1} (${match.categoryName}): ${result.error || 'error'}`)
      } else {
        saved.push(result)
      }
    } catch (err) {
      errors.push(`#${i + 1}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  await clearExpenseContext(args.db, args.conversationId)

  const lines: string[] = [`✅ ${saved.length} gastos registrados:`]
  for (const r of saved) {
    const parts = [`💰 $${r.amount.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`, `📁 ${r.categoryName}`]
    if (r.providerName) parts.push(`🏭 ${r.providerName}`)
    lines.push(`• ${parts.join(' · ')}`)
  }
  if (errors.length) {
    lines.push('')
    lines.push(`⚠️ No se registraron: ${errors.join(' | ')}`)
  }
  const msg = lines.join('\n')
  await sendTextResponse(args, msg)
  return { handled: true, text: msg }
}

async function handleMultiExpenseConfirmReply(
  args: ProcessExpenseMessageArgs,
  ctx: ExpenseContextState,
  replyId: string,
): Promise<ProcessExpenseResult> {
  if (replyId === EXP_MULTI_CONFIRM_ID) {
    await clearExpenseContext(args.db, args.conversationId)
    return confirmMultipleExpenses(args, { ...ctx, stage: 'confirming', pendingMultiple: ctx.pendingMultiple })
  }

  if (replyId === EXP_MULTI_EDIT_ID) {
    const count = (ctx.pendingMultiple || []).length
    await saveExpenseContext(args.db, args.conversationId, {
      ...ctx,
      stage: 'confirming',
      awaitingMultiEditIndex: true,
      multiEditingIndex: null,
    })
    const msg = `¿Cuál querés editar? Escribí el número (1-${count}).`
    await sendTextResponse(args, msg)
    return { handled: true, text: msg }
  }

  // Cancelar (o cualquier otra reply).
  await logExpenseExtraction(args, {
    status: 'cancelled',
    rawText: args.text || null,
    debug: { flow: 'multi_confirm_reply_cancel', replyId },
  })
  await clearExpenseContext(args.db, args.conversationId)
  const msg = 'Listo, no guardé los gastos. 👍'
  await sendTextResponse(args, msg)
  return { handled: true, text: msg }
}

/**
 * Responde por texto dentro de un flujo multi-expense:
 * - collecting: completa el campo faltante del gasto señalado.
 * - confirming: "si/confirmar" confirma todo; un número edita ese gasto;
 *   "cancelar" aborta; mientras edita, aplica el cambio.
 */
async function handleMultiExpenseReply(
  args: ProcessExpenseMessageArgs,
  ctx: ExpenseContextState,
): Promise<ProcessExpenseResult> {
  const items = [...(ctx.pendingMultiple || [])]
  const text = (args.text || '').trim()
  const lower = text.toLowerCase()

  if (ctx.stage === 'collecting' && ctx.multiMissingIndex !== null && ctx.multiMissingIndex !== undefined && ctx.multiMissingField) {
    const idx = ctx.multiMissingIndex
    if (ctx.multiMissingField === 'amount') {
      const num = parseFloatSafe(text)
      if (!num) {
        await saveExpenseContext(args.db, args.conversationId, { ...ctx })
        return { handled: true, text: 'Sigo sin entender el monto. Escribí solo el número (ej: 5000).' }
      }
      items[idx] = { ...items[idx], amount: num }
    } else {
      items[idx] = { ...items[idx], category: text || null }
    }
    await saveExpenseContext(args.db, args.conversationId, {
      ...ctx,
      pendingMultiple: items,
      multiMissingIndex: null,
      multiMissingField: null,
    })
    return advanceMultiExpense(args)
  }

  if (ctx.stage === 'confirming') {
    if (lower.includes('cancelar') || lower === 'no') {
      await clearExpenseContext(args.db, args.conversationId)
      const msg = 'Listo, no guardé los gastos. 👍'
      await sendTextResponse(args, msg)
      return { handled: true, text: msg }
    }

    if (ctx.awaitingMultiEditIndex) {
      const n = parseInt(text, 10)
      if (!n || n < 1 || n > items.length) {
        return { handled: true, text: `Elegí un número entre 1 y ${items.length}.` }
      }
      const idx = n - 1
      await saveExpenseContext(args.db, args.conversationId, {
        ...ctx,
        awaitingMultiEditIndex: false,
        multiEditingIndex: idx,
      })
      const it = items[idx]
      const amountLabel = it.amount ? `$${it.amount.toLocaleString('es-AR', { minimumFractionDigits: 2 })}` : '?'
      const msg = `Gasto #${n}: 💰 ${amountLabel} · 📁 ${it.category || 'Sin categoría'}.\n¿Qué querés corregir? (ej: "monto 30000", "categoría pintura", "proveedor Juan")`
      await sendTextResponse(args, msg)
      return { handled: true, text: msg }
    }

    if (ctx.multiEditingIndex !== null && ctx.multiEditingIndex !== undefined) {
      const idx = ctx.multiEditingIndex
      const updated = { ...items[idx] }
      const montoMatch = text.match(/monto\s+[\d.,]+/i)
      const bareAmount = !montoMatch && /^[\d.,]+$/.test(text)
      if (montoMatch || bareAmount) {
        const num = parseFloatSafe(text.match(/[\d.,]+/)?.[0] || '')
        if (num) updated.amount = num
      }
      const catMatch = text.match(/categor[ií]a\s+(.+)/i)
      if (catMatch) updated.category = catMatch[1].trim()
      const provMatch = text.match(/proveedor\s+(.+)/i)
      if (provMatch) updated.provider = provMatch[1].trim()
      if (!montoMatch && !bareAmount && !catMatch && !provMatch) {
        // Texto suelto → tratarlo como categoría.
        updated.category = text || updated.category
      }
      items[idx] = updated
      await saveExpenseContext(args.db, args.conversationId, {
        ...ctx,
        pendingMultiple: items,
        multiEditingIndex: null,
      })
      return advanceMultiExpense(args)
    }

    // Sin modo edición activo: confirmar o volver a pedir.
    if (lower.includes('confirmar') || lower === 'si' || lower === 'sí' || lower === 'ok') {
      return confirmMultipleExpenses(args, { ...ctx, pendingMultiple: ctx.pendingMultiple })
    }

    const n = parseInt(text, 10)
    if (n && n >= 1 && n <= items.length) {
      await saveExpenseContext(args.db, args.conversationId, {
        ...ctx,
        multiEditingIndex: n - 1,
      })
      const it = items[n - 1]
      const amountLabel = it.amount ? `$${it.amount.toLocaleString('es-AR', { minimumFractionDigits: 2 })}` : '?'
      const msg = `Gasto #${n}: 💰 ${amountLabel} · 📁 ${it.category || 'Sin categoría'}.\n¿Qué querés corregir? (ej: "monto 30000", "categoría pintura", "proveedor Juan")`
      await sendTextResponse(args, msg)
      return { handled: true, text: msg }
    }

    return {
      handled: true,
      text: `¿Confirmás todos los gastos? Respondé "si" para confirmar, un número (1-${items.length}) para editar, o "cancelar".`,
    }
  }

  return { handled: false }
}

/** Recibe un intent 'multi_expense' y arranca el flujo de confirmación. */
export async function processMultipleExpenses(
  args: ProcessExpenseMessageArgs,
  items: MultiExpenseItem[],
): Promise<ProcessExpenseResult> {
  const valid = items.filter(i => i.amount !== null || i.category !== null)
  if (valid.length < 2) {
    return { handled: false }
  }

  await saveExpenseContext(args.db, args.conversationId, {
    stage: 'collecting',
    pendingMultiple: valid,
    multiMissingIndex: null,
    multiMissingField: null,
    awaitingMultiEditIndex: false,
    multiEditingIndex: null,
  })
  await logExpenseExtraction(args, {
    status: 'collecting',
    rawText: args.text || null,
    extractorSource: 'llm',
    confianza: 'alta',
    debug: {
      flow: 'multi_expense_start',
      count: valid.length,
      items: valid.map(i => ({ amount: i.amount, category: i.category })),
    },
  })
  return advanceMultiExpense(args)
}

export async function processExpenseMessage(
  args: ProcessExpenseMessageArgs,
  extraction?: UnifiedExtraction,
): Promise<ProcessExpenseResult> {
  const ctx = await loadExpenseContext(args.db, args.conversationId)

  // Comando por texto "corregir categoría" (se promete en la confirmación de
  // gastos con categoría nueva). Gana sobre cualquier multi-turno previo.
  if (args.messageType === 'text' && args.text && isCategoryCorrectionCommand(args.text)) {
    return handleCategoryCorrectionStart(args, ctx)
  }

  // Segunda vuelta de la corrección: estamos esperando la categoría correcta.
  if (ctx.correctingCategory && args.messageType === 'text') {
    return handleCategoryCorrectionReply(args, ctx)
  }

  // Multi-expense pendiente → responder al flujo (campo faltante / edición / confirmar).
  if (
    ctx.pendingMultiple &&
    (ctx.stage === 'collecting' || ctx.stage === 'confirming') &&
    args.messageType === 'text'
  ) {
    return handleMultiExpenseReply(args, ctx)
  }

  // Nuevo mensaje multi-expense (intent del LLM o fallback regex).
  if (
    extraction?.intent === 'multi_expense' &&
    extraction.multipleExpenses &&
    extraction.multipleExpenses.length >= 2
  ) {
    return processMultipleExpenses(args, extraction.multipleExpenses)
  }

  if (ctx.stage === 'collecting' && ctx.pendingExpense && args.messageType === 'text') {
    return handleCollectingReply(args, ctx)
  }

  let parsed: ParsedExpense | null = null
  let mediaUrl: string | null = null
  let processingStage = 'parse'

  try {
    if (args.messageType === 'text' && args.text) {
      const regexParsed = parseExpense(args.text)
      if (extraction && extraction.intent === 'gasto') {
        parsed = {
          amount: extraction.monto,
          description: regexParsed.description,
          category: extraction.categoria,
          tipoGasto: extraction.tipo_gasto,
          provider: extraction.proveedor,
          employee: extraction.empleado_gasto,
          payment_method: extraction.metodo_pago,
          // Merge con regex: conserva split payments y saldo que el LLM no modela.
          payments: regexParsed.payments || undefined,
          saldo: regexParsed.saldo || (extraction.saldo_pendiente
            ? [{ amount: extraction.saldo_pendiente, payment_method: extraction.metodo_pago || 'efectivo' }]
            : undefined),
          saldoPendiente: extraction.saldo_pendiente || regexParsed.saldoPendiente || null,
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

    processingStage = 'matching'
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

    processingStage = 'execution'
    return executeAndConfirmExpense(args, parsed, match, mediaUrl)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[expense] process error:', msg)
    await logExpenseExtraction(args, {
      status: 'error',
      rawText: args.text || args.mediaId || null,
      extractorSource: parsed?.extractorSource,
      confianza: parsed?.confianza,
      amount: parsed?.amount,
      category: parsed?.category,
      provider: parsed?.provider,
      employee: parsed?.employee,
      errorMessage: msg,
      debug: {
        messageType: args.messageType,
        processingStage,
        tipoGasto: parsed?.tipoGasto,
        extraction: extraction
          ? {
              intent: extraction.intent,
              monto: extraction.monto,
              categoria: extraction.categoria,
              proveedor: extraction.proveedor,
              empleado_gasto: extraction.empleado_gasto,
            }
          : null,
      },
    })
    return {
      handled: true,
      error: msg,
      text: '❌ No pude procesar el gasto. Intentá de nuevo o contactá al administrador.',
    }
  }
}

export { loadExpenseContext, saveExpenseContext, clearExpenseContext, parseExpense }
export { isCategoryCorrectionCommand } from './command'
export { looksLikeExpense } from './parse-expense'
export type { ParsedExpense, ExpenseContextState }
