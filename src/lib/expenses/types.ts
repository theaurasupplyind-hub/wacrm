import type { MultiExpenseItem } from '@/lib/bot-llm/types'

export interface ParsedExpense {
  amount: number | null
  description: string | null
  category: string | null
  tipoGasto?: 'compra' | 'pago' | 'gasto' | null
  provider: string | null
  employee: string | null
  payment_method: string | null
  payments?: PaymentSplit[] | null  // split payments
  saldo?: PaymentSplit[] | null    // saldo/deuda restante
  saldoPendiente?: number | null
  reference: string | null
  date: string | null // YYYY-MM-DD
  isExpenseIntent: boolean
  raw: string
  /**
   * True cuando el parser no pudo anclar el monto a una palabra de dinero y
   * usó la heurística del "número más grande" → candidato a confirmación.
   */
  amountAmbiguous?: boolean
  /**
   * Origen del parseo (para auditoría): 'llm' | 'fallback' | 'regex' |
   * 'whisper_regex' | 'multimodal'. Se setea en processExpenseMessage.
   */
  extractorSource?: string | null
  /** Confianza del extractor unificado, si vino del LLM (alta/media/baja). */
  confianza?: string | null
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
  saldoResult?: ExpenseExecutionResult | null  // segundo expense (saldo/deuda)
  status: string
  isNewCategory: boolean
  error?: string
}

export interface ExpenseContextState {
  pendingExpense?: ParsedExpense | null
  pendingMatch?: ExpenseFuzzyMatch | null
  lastExpenseId?: number | null
  /** Monto del último gasto confirmado, para armar el mensaje de corrección. */
  lastExpenseAmount?: number | null
  /** Nombre de la categoría del último gasto confirmado. */
  lastCategoryName?: string | null
  awaitingConfirmation?: boolean
  stage?: ExpenseStage
  missingField?: 'amount' | 'category' | 'entity' | null
  /** True mientras el usuario está corrigiendo la categoría del último gasto. */
  correctingCategory?: boolean
  /** Id del gasto cuya categoría se está corrigiendo. */
  correctingCategoryExpenseId?: number | null
  /** Multi-expense: lista de gastos detectados en un solo mensaje. */
  pendingMultiple?: MultiExpenseItem[] | null
  /** Índice (0-based) del gasto incompleto cuyo campo se está esperando. */
  multiMissingIndex?: number | null
  multiMissingField?: 'amount' | 'category' | null
  /** Esperando que el usuario elija qué gasto editar (número). */
  awaitingMultiEditIndex?: boolean
  /** Índice (0-based) del gasto que se está editando. */
  multiEditingIndex?: number | null
}

export type ExpenseStage = 'idle' | 'collecting' | 'confirming'

export type ExpenseMessageType = 'text' | 'audio' | 'image' | 'document'
