import type { VoucherData } from './voucher-extraction'
import type { FacturaPendiente } from '../facbal/client'

const MONTO_TOLERANCIA = 50

export type MatchStatus = 'matched' | 'ambiguous' | 'no_match'

export interface MatchResult {
  status: MatchStatus
  mensajeRespuesta: string
  matchedInvoiceId: number | null
  candidatas: FacturaPendiente[]
}

function formatMonto(n: number): string {
  return `$${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatFactura(f: FacturaPendiente): string {
  return `${f.numero_factura} (${formatMonto(f.saldo_pendiente)})`
}

/**
 * Match a voucher's extracted data against pending invoices.
 *
 * Returns the action to take and the WhatsApp reply text.
 */
export function matchVoucher(args: {
  voucher: VoucherData
  facturasPendientes: FacturaPendiente[]
}): MatchResult {
  const { voucher, facturasPendientes } = args

  if (facturasPendientes.length === 0) {
    return {
      status: 'no_match',
      mensajeRespuesta:
        'No encontramos facturas pendientes a tu nombre. Un agente revisará tu caso y te contactará pronto.',
      matchedInvoiceId: null,
      candidatas: [],
    }
  }

  if (voucher.monto === null || voucher.monto <= 0) {
    const lineas = facturasPendientes.map(formatFactura)
    if (facturasPendientes.length === 1 && lineas.length === 1) {
      return {
        status: 'ambiguous',
        mensajeRespuesta:
          'No pudimos leer el monto del comprobante. ¿Es para la factura ' +
          lineas[0] +
          '? Respondé "sí" para confirmar o indicá el número de factura correcto.',
        matchedInvoiceId: null,
        candidatas: facturasPendientes,
      }
    }
    return {
      status: 'ambiguous',
      mensajeRespuesta:
        'No pudimos leer el monto del comprobante. ¿A cuál de estas facturas corresponde? ' +
        'Respondé con el número de factura.\n\n' +
        lineas.join('\n'),
      matchedInvoiceId: null,
      candidatas: facturasPendientes,
    }
  }

  const candidatas = facturasPendientes.filter(
    (f) => Math.abs(voucher.monto! - f.saldo_pendiente) <= MONTO_TOLERANCIA,
  )

  if (candidatas.length === 0) {
    const lineas = facturasPendientes.map(formatFactura)
    return {
      status: 'no_match',
      mensajeRespuesta:
        `Recibimos tu comprobante por ${formatMonto(voucher.monto)}, ` +
        'pero no coincide con ninguna factura pendiente. ' +
        'Tenés estas facturas pendientes:\n\n' +
        lineas.join('\n') +
        '\n\n¿A cuál corresponde? Respondé con el número de factura o un agente te contactará.',
      matchedInvoiceId: null,
      candidatas: facturasPendientes,
    }
  }

  if (candidatas.length === 1) {
    const f = candidatas[0]
    return {
      status: 'matched',
      mensajeRespuesta:
        `¡Gracias! Registramos tu pago de ${formatMonto(voucher.monto)} ` +
        `para la factura ${f.numero_factura}. ` +
        `Saldo restante: ${formatMonto(f.saldo_pendiente - voucher.monto!)}. ` +
        'Cualquier consulta no dudes en escribirnos.',
      matchedInvoiceId: f.invoice_id,
      candidatas,
    }
  }

  const lineas = candidatas.map(formatFactura)
  return {
    status: 'ambiguous',
    mensajeRespuesta:
      `Recibimos tu comprobante por ${formatMonto(voucher.monto)}. ` +
      'El monto coincide con varias facturas. ¿A cuál corresponde?\n\n' +
      lineas.join('\n') +
      '\n\nRespondé con el número de factura.',
    matchedInvoiceId: null,
    candidatas,
  }
}
