import type { BotIntent, UnifiedExtraction } from '@/lib/bot-llm/types'
import type { ClarifyContextState } from '@/lib/bot-llm/clarify-context'

/**
 * Acciones que el motor (`engine.ts`) propone para un turno.
 *
 * El motor es PURO: no ejecuta nada. Devuelve una lista ordenada de acciones y
 * el adapter (webhook `route.ts`) las materializa dentro de los `bgTasks` que
 * ve `after()`. Fase 1: el motor reproduce el comportamiento actual, así que
 * las acciones son 1:1 con lo que hoy hace `route.ts` inline.
 *
 * `deliver`: forward-compat para Fase 4-5. `'handler'` (default, Fase 1) = el
 * handler envía su propio mensaje; `'caller'` = el motor lo emite por el
 * SenderPort. En Fase 1 no se usa todavía.
 */
export type ContextDomain = 'expense' | 'attendance' | 'voucher' | 'clarify' | 'order'

export interface TurnButton {
  id: string
  title: string
}

export type TurnAction =
  | { kind: 'reply_text'; text: string }
  /** Botones con fallback a texto con letras (semántica de `sendClarifyQuestion`).
   *  `clearOnFailure`: si el envío falla, limpiar el clarify guardado (para no
   *  dejar al usuario atrapado). Se usa sólo en `clarify_ask`. */
  | { kind: 'reply_buttons'; body: string; options: TurnButton[]; clearOnFailure?: boolean }
  | { kind: 'clear_context'; domain: ContextDomain }
  /** Limpia el follow-up "no encontré facturas para X" (nombre/monto). */
  | { kind: 'clear_voucher_awaiting' }
  | { kind: 'save_clarify'; state: ClarifyContextState }
  | {
      kind: 'run_expense'
      text: string
      extraction: UnifiedExtraction | null
      deliver?: 'handler' | 'caller'
    }
  | {
      kind: 'run_attendance'
      text: string
      extraction: UnifiedExtraction | null
      deliver?: 'handler' | 'caller'
    }
  | { kind: 'run_order'; text: string; deliver?: 'handler' | 'caller' }
  | { kind: 'run_assistant'; text: string; extraction: UnifiedExtraction | null }
  | {
      kind: 'run_voucher_text'
      clientName: string
      destName: string | null
      metodoPago: 'Efectivo' | 'Transferencia'
      monto: number | null
      fecha: string | null
    }
  /** Voucher por texto que responde a un pending (letra/nombre/sí). */
  | { kind: 'run_voucher_message_text'; text: string }
  /** Guarda un texto corto como posible respuesta futura a un voucher. */
  | { kind: 'store_voucher_pending_text'; text: string }
  | { kind: 'none' }

/** Intents que el motor considera "orden fuerte" para superseder un clarify. */
export type StrongIntent = BotIntent
