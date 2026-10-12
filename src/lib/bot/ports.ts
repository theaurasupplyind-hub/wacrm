/**
 * Puertos del motor de turnos (ports & adapters).
 *
 * FASE 1: sólo tipos. El motor todavía es una función pura (`engine.planTurn`)
 * y el adapter hace el I/O directo. Estos contratos definen hacia dónde va la
 * migración (Fase 4-5) para que los adapters no importen `supabaseAdmin` ni
 * `engineSend*` desde el motor.
 *
 * Regla dura (objetivo): el motor y los puertos NO importan Supabase, Meta ni
 * handlers concretos.
 */

import type { ExpenseContextState } from '@/lib/expenses/types'
import type { AttendanceContextState } from '@/lib/attendance/context'
import type { VoucherContextState } from '@/lib/ai/voucher-context'
import type { OrderContext } from '@/lib/pedidos/types'
import type { ClarifyContextState } from '@/lib/bot-llm/clarify-context'
import type { UnifiedExtraction } from '@/lib/bot-llm/types'
import type { TurnAction, ContextDomain } from './actions'

export interface ContextStorePort {
  loadExpense(conversationId: string): Promise<ExpenseContextState | null>
  loadAttendance(conversationId: string): Promise<AttendanceContextState | null>
  loadVoucher(conversationId: string): Promise<VoucherContextState | null>
  loadClarify(conversationId: string): Promise<{ state: ClarifyContextState; expired: boolean } | null>
  loadOrder(conversationId: string): Promise<OrderContext | null>
  saveOrder(conversationId: string, state: OrderContext): Promise<void>
  clear(conversationId: string, domain: ContextDomain): Promise<void>
}

export interface SenderPort {
  text(args: {
    accountId: string
    userId: string
    conversationId: string
    contactId: string
    text: string
  }): Promise<void>
  buttons(args: {
    accountId: string
    userId: string
    conversationId: string
    contactId: string
    bodyText: string
    buttons: { id: string; title: string }[]
  }): Promise<void>
}

export interface HandlerResult {
  text: string | null
  replied: boolean
}

export interface HandlerPorts {
  runExpense(args: {
    text: string
    extraction: UnifiedExtraction | null
    deliver: 'handler' | 'caller'
  }): Promise<HandlerResult>
  runAttendance(args: {
    text: string
    extraction: UnifiedExtraction | null
    deliver: 'handler' | 'caller'
  }): Promise<HandlerResult>
  runOrder(args: { text: string; deliver: 'handler' | 'caller' }): Promise<HandlerResult>
  runVoucherMedia(): Promise<void>
  runVoucherText(args: { text: string }): Promise<void>
  runAssistant(args: { text: string; extraction: UnifiedExtraction | null }): Promise<void>
}

export interface PendingSummary {
  expense: boolean
  attendance: boolean
  voucher: boolean
  order: boolean
  clarify: boolean
}

export interface PlannerPort {
  plan(input: {
    text: string
    extraction: UnifiedExtraction | null
    pending: PendingSummary
    history: { role: string; content: string }[]
    lastButtonId: string | null
    allowedActions: TurnAction['kind'][]
  }): Promise<{ actions: TurnAction[]; confidence: 'alta' | 'media' | 'baja'; rationale?: string }>
}

export interface TelemetryPort {
  logDecision(args: Record<string, unknown>): Promise<void>
  recordTrace(args: Record<string, unknown>): Promise<void>
}
