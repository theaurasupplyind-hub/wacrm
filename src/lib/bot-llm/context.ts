import type { ExpenseContextState } from '@/lib/expenses/types'
import type { AttendanceContextState } from '@/lib/attendance/context'
import type { VoucherContextState } from '@/lib/ai/voucher-context'

export interface BotContextInput {
  expenseCtx?: ExpenseContextState | null
  attendanceCtx?: AttendanceContextState | null
  voucherCtx?: VoucherContextState | null
  voiceCtx?: {
    pendingVariantItems?: unknown[] | null
    pendingClientName?: string | null
    pendingInvoice?: unknown | null
  } | null
}

/**
 * Convierte el estado multi-turn de los bots en un bloque de texto legible para
 * el LLM, de modo que respuestas cortas ("juan", "8:30", "5000", "sí") se
 * resuelvan con el contexto pendiente en lugar de perderse.
 */
export function buildBotContextText(input: BotContextInput): string {
  const lines: string[] = []

  const exp = input.expenseCtx
  if (exp?.pendingMultiple && (exp.stage === 'collecting' || exp.stage === 'confirming')) {
    if (exp.stage === 'collecting') {
      const idx = exp.multiMissingIndex
      const field =
        exp.multiMissingField === 'amount'
          ? 'el monto'
          : exp.multiMissingField === 'category'
            ? 'la categoría'
            : 'un dato'
      lines.push(
        `Gastos múltiples pendientes: hay ${exp.pendingMultiple.length} gastos por confirmar. Se está esperando ${field} del gasto #${(idx ?? 0) + 1}.`,
      )
    } else {
      lines.push(
        'Gastos múltiples pendientes: el bot mostró una lista con botones [Confirmar todos / Editar / Cancelar]. El usuario puede responder por texto: un número para editar ese gasto, "si" para confirmar todos, o "cancelar".',
      )
    }
  } else if (exp?.pendingExpense) {
    if (exp.stage === 'collecting') {
      const esperando =
        exp.missingField === 'amount'
          ? 'el monto'
          : exp.missingField === 'category'
            ? 'la categoría'
            : 'un dato del gasto'
      lines.push(`Gasto pendiente: el usuario está completando un gasto. Se está esperando ${esperando}.`)
    } else if (exp.stage === 'confirming') {
      lines.push('Gasto pendiente: el bot mostró un preview con botones [Confirmar / Corregir / Cancelar]. El usuario está respondiendo por texto.')
    }
  } else if (exp?.correctingCategory && exp.correctingCategoryExpenseId) {
    lines.push('Gasto: el usuario quiere corregir la categoría del último gasto registrado. Se está esperando la categoría correcta (ej: luz, alquiler, sueldos y salarios).')
  }

  const att = input.attendanceCtx
  if (att?.pendingType) {
    const tipo =
      att.pendingType === 'arrival'
        ? 'llegada'
        : att.pendingType === 'departure'
          ? 'salida'
          : 'estado'
    if (att.pendingEmployee && !att.pendingTime) {
      lines.push(`Asistencia pendiente: se espera la hora de la ${tipo} de ${att.pendingEmployee}.`)
    } else if (!att.pendingEmployee) {
      lines.push(`Asistencia pendiente: se espera el nombre del empleado (¿de quién es?) para registrar ${tipo}.`)
    }
  } else if (att?.awaitingCorrection) {
    lines.push('Asistencia: el bot mostró botones de corrección de hora. El usuario responde a los botones.')
  }

  const vc = input.voucherCtx
  if (vc?.pending && vc.pending.length > 0) {
    lines.push(
      `Voucher: hay ${vc.pending.length} comprobante(s) pendiente(s) de confirmar. El usuario puede responder con una letra (A, B...), "sí", o un nombre.`,
    )
  }

  const vo = input.voiceCtx
  if (vo?.pendingVariantItems && vo.pendingVariantItems.length > 0) {
    lines.push('Pedido pendiente: el usuario debe elegir una variante de producto (sin tela, lienzo profesional, etc.).')
  } else if (vo?.pendingClientName) {
    lines.push('Pedido pendiente: se está esperando el nombre del cliente.')
  }

  return lines.join('\n')
}
