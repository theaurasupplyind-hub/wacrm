import type { ExpenseContextState } from '@/lib/expenses/types'
import type { AttendanceContextState } from '@/lib/attendance/context'
import type { VoucherContextState, AwaitingClientMatch } from '@/lib/ai/voucher-context'
import type { OrderContext } from '@/lib/pedidos/types'
import { isOrderContextActive, getStaleQuote } from '@/lib/pedidos/context'
import type { ClarifyContextState } from './clarify-context'

export interface BotContextInput {
  expenseCtx?: ExpenseContextState | null
  attendanceCtx?: AttendanceContextState | null
  voucherCtx?: VoucherContextState | null
  voucherAwaitingMatch?: AwaitingClientMatch | null
  orderCtx?: OrderContext | null
  clarifyCtx?: ClarifyContextState | null
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
  if (input.voucherAwaitingMatch) {
    const metodo = input.voucherAwaitingMatch.metodoPago === 'Efectivo' ? 'efectivo' : 'transferencia'
    const nombre = input.voucherAwaitingMatch.attemptedName
      ? ` para "${input.voucherAwaitingMatch.attemptedName}"`
      : ''
    const espera = input.voucherAwaitingMatch.monto == null
      ? 'el monto del pago o el nombre completo del cliente'
      : 'el nombre exacto del cliente'
    lines.push(
      `Voucher: no encontramos facturas${nombre} (pago en ${metodo}). Se espera ${espera}. Si el mensaje es un monto o un nombre, devolvé intent "voucher" con monto/proveedor.`,
    )
  }

  const cc = input.clarifyCtx
  if (cc && Array.isArray(cc.options) && cc.options.length > 0) {
    const opciones = cc.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o.title}`).join(' · ')
    lines.push(
      `Aclaración pendiente: "${cc.question}" Opciones: ${opciones}. Si el mensaje responde a esto, devolvé el intent de la opción elegida.`,
    )
  }

  const order = input.orderCtx
  // Fix #3 (notas-fallos-reales.md): el contexto vencido NO se presenta como
  // pendiente — el LLM ofrecía cancelar cotizaciones muertas. Si venció pero es
  // recordable, se marca como vencida para que ofrezca re-armarla.
  const orderActive = isOrderContextActive(order ?? null)
  const staleQuote = orderActive ? null : getStaleQuote(order ?? null)
  if (staleQuote) {
    const totalTxt =
      staleQuote.total && staleQuote.total > 0 ? ` (total $${staleQuote.total.toLocaleString('es-AR')})` : ''
    lines.push(
      `Cotización anterior VENCIDA${totalTxt}: ya no está pendiente, NO la ofrezcas para aceptar/cancelar y NO tomes "sí"/"cancelar" como respuesta a ella. Si el usuario la menciona, ofrecé armarla de nuevo pidiendo productos y medidas.`,
    )
  } else if (!orderActive) {
    // Contexto inactivo y no recordable (muy viejo o sin stage): no se
    // menciona. El LLM no debe ofrecer nada de un pedido muerto.
  } else if (order?.awaitingOrderItems) {
    lines.push('El dueño pidió crear un presupuesto y está por indicar los productos/medidas. Todavía no hay presupuesto guardado.')
  } else if (order?.awaitingQuoteApproval) {
    const itemsTxt = order.items
      .filter(it => !it.faltante)
      .map((it, i) => `${i + 1}. ${it.cantidad > 1 ? `${it.cantidad}x ` : ''}${it.descripcion}`)
      .join(' · ')
    lines.push(
      `Cotización pendiente (solo preview; todavía NO se creó ningún presupuesto): ${itemsTxt || '(sin ítems)'}. Total ${order.total}. El usuario puede aceptar para iniciar la creación o cancelar.`,
    )
  } else if (order && order.stage === 'confirming') {
    const itemsTxt = order.items
      .filter(it => !it.faltante)
      .map((it, i) => `${i + 1}. ${it.cantidad > 1 ? `${it.cantidad}x ` : ''}${it.descripcion}`)
      .join(' · ')
    const falt = order.faltantes.length > 0 ? ` Sin cotizar: ${order.faltantes.join(', ')}.` : ''
    const cliente = order.clienteNombre ? ` para ${order.clienteNombre}` : ''
    lines.push(
      `Pedido pendiente (presupuesto${cliente}): ${itemsTxt || '(sin ítems)'}. Total ${order.total}.${falt} El usuario puede confirmar ("sí"), cancelar ("no") o corregir ítems/medidas/variantes/precios: si el mensaje continúa el pedido, devolvé intent "pedido".`,
    )
  }

  return lines.join('\n')
}
