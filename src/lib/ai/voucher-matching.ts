import type { VoucherData } from './voucher-extraction'
import type { MatchVoucherCandidate } from '../facbal/client'

const SCORE_MATCHED = 0.5

export type MatchStatus = 'matched' | 'ambiguous' | 'no_match'

export interface MatchResult {
  status: MatchStatus
  mensajeRespuesta: string
  matchedInvoiceId: number | null
  candidatas: MatchVoucherCandidate[]
}

function formatMonto(n: number): string {
  return `$${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/**
 * Match a voucher's extracted data against candidate invoices from the API.
 * candidates should already be sorted by score descending.
 */
export function matchVoucher(args: {
  voucher: VoucherData
  candidates: MatchVoucherCandidate[]
}): MatchResult {
  const { voucher, candidates } = args
  const nombreCliente = voucher.nombre_cliente?.trim() || null

  if (candidates.length === 0) {
    return {
      status: 'no_match',
      mensajeRespuesta:
        nombreCliente
          ? `Buscamos facturas para "${nombreCliente}" pero no encontramos ninguna pendiente que coincida con el monto. Un agente revisará tu comprobante.`
          : 'No encontramos facturas pendientes que coincidan con el comprobante. Un agente lo revisará.',
      matchedInvoiceId: null,
      candidatas: [],
    }
  }

  // Filter candidates that actually match the monto within tolerance
  const monto = voucher.monto
  const byScore = [...candidates].sort((a, b) => b.score - a.score)
  const best = byScore[0]

  // If best candidate has good score and monto is within tolerance (or no monto needed)
  const montoOk = monto === null || monto <= 0 || Math.abs(monto - best.saldo_pendiente) <= 50

  if (best.score >= SCORE_MATCHED && montoOk) {
    return {
      status: 'matched',
      mensajeRespuesta:
        nombreCliente
          ? `Gracias ${nombreCliente}. Tu pago de ${formatMonto(monto ?? best.saldo_pendiente)} corresponde a ${best.cliente_nombre} — Factura ${best.numero_factura} (saldo: ${formatMonto(best.saldo_pendiente)}). Lo estamos procesando.`
          : `Registramos tu pago de ${formatMonto(monto ?? best.saldo_pendiente)} para ${best.cliente_nombre} — Factura ${best.numero_factura}. Lo estamos procesando.`,
      matchedInvoiceId: best.invoice_id,
      candidatas: [best],
    }
  }

  // Too many close matches — ambiguous
  const lineas = byScore.map(
    (c, i) =>
      `${i + 1}. ${c.cliente_nombre} — Factura ${c.numero_factura} — Saldo: ${formatMonto(c.saldo_pendiente)}`,
  )

  const intro =
    nombreCliente && byScore.some((c) => c.score > 0.2)
      ? `Encontramos diferentes clientes con saldos y nombres parecidos a "${nombreCliente}". ¿Cuál es correcto?`
      : monto && monto > 0
        ? `Encontramos varias facturas con saldo cercano a ${formatMonto(monto)}. ¿A cuáles corresponde tu pago?`
        : 'No pudimos identificar el cliente o el monto. Decinos el número de factura o el nombre del cliente.'

  return {
    status: 'ambiguous',
    mensajeRespuesta:
      intro + '\n\n' + lineas.join('\n') + '\n\nRespondé con el número de factura o el nombre completo.',
    matchedInvoiceId: null,
    candidatas: byScore,
  }
}
