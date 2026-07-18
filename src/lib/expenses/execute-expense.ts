import { createExpense, type ExpenseCreatePayload } from '@/lib/facbal/client'
import type { ParsedExpense, ExpenseFuzzyMatch, ExpenseExecutionResult } from './types'

export async function executeExpense(
  parsed: ParsedExpense,
  match: ExpenseFuzzyMatch,
  options: {
    source?: string
    createdByContactId?: number | null
    mediaUrl?: string | null
    mediaId?: string | null
  } = {},
): Promise<ExpenseExecutionResult> {
  if (!parsed.amount || parsed.amount <= 0) {
    return {
      expenseId: null,
      amount: 0,
      description: parsed.description || 'Gasto',
      categoryName: match.categoryName || 'Sin categoría',
      providerName: match.providerName,
      employeeName: match.employeeName,
      status: 'cancelled',
      isNewCategory: match.categoryWasCreated,
      error: 'No se detectó un monto válido.',
    }
  }

  if (!match.categoryId) {
    return {
      expenseId: null,
      amount: parsed.amount,
      description: parsed.description || 'Gasto',
      categoryName: parsed.category || 'Sin categoría',
      providerName: match.providerName,
      employeeName: match.employeeName,
      status: 'cancelled',
      isNewCategory: false,
      error: 'No se pudo determinar la categoría del gasto.',
    }
  }

  const description = [parsed.description]
  if (match.providerName && !parsed.description?.toLowerCase().includes(match.providerName.toLowerCase())) {
    description.push(`(proveedor: ${match.providerName})`)
  }
  if (match.employeeName && !parsed.description?.toLowerCase().includes(match.employeeName.toLowerCase())) {
    description.push(`(empleado: ${match.employeeName})`)
  }

  const payload: ExpenseCreatePayload = {
    date: parsed.date || new Date().toISOString().slice(0, 10),
    amount: parsed.amount,
    description: description.join(' ').trim(),
    category_id: match.categoryId,
    provider_id: match.providerId,
    employee_id: match.employeeId,
    payment_method: parsed.payment_method || 'efectivo',
    reference: parsed.reference || '',
    source: options.source || 'whatsapp',
    created_by_user_id: null,
    created_by_contact_id: options.createdByContactId || null,
    status: 'confirmed',
    raw_input: parsed.raw,
    media_url: options.mediaUrl || null,
    media_id: options.mediaId || null,
  }

  if (parsed.payments && parsed.payments.length > 1) {
    payload.payments = parsed.payments
  }

  const expense = await createExpense(payload)

  return {
    expenseId: expense.id,
    amount: expense.amount,
    description: expense.description,
    categoryName: match.categoryName || 'Sin categoría',
    providerName: match.providerName,
    employeeName: match.employeeName,
    payments: parsed.payments || null,
    status: expense.status,
    isNewCategory: match.categoryWasCreated,
  }
}
