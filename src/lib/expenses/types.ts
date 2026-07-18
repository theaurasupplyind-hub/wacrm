export interface ParsedExpense {
  amount: number | null
  description: string | null
  category: string | null
  provider: string | null
  employee: string | null
  payment_method: string | null
  payments?: PaymentSplit[] | null  // split payments
  reference: string | null
  date: string | null // YYYY-MM-DD
  isExpenseIntent: boolean
  raw: string
}

export interface PaymentSplit {
  amount: number
  payment_method: string
}

export interface ExpenseFuzzyMatch {
  categoryId: number | null
  categoryName: string | null
  categoryWasCreated: boolean
  providerId: number | null
  providerName: string | null
  employeeId: number | null
  employeeName: string | null
}

export interface ExpenseExecutionResult {
  expenseId: number | null
  amount: number
  description: string
  categoryName: string
  providerName: string | null
  employeeName: string | null
  payments?: PaymentSplit[] | null
  status: string
  isNewCategory: boolean
  error?: string
}

export interface ExpenseContextState {
  pendingExpense?: ParsedExpense | null
  pendingMatch?: ExpenseFuzzyMatch | null
  lastExpenseId?: number | null
  awaitingConfirmation?: boolean
}

export type ExpenseMessageType = 'text' | 'audio' | 'image' | 'document'
