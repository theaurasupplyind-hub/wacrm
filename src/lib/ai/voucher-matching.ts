import type { VoucherData } from './voucher-extraction'
import type { MatchVoucherCandidate, DestinationCandidate } from '../facbal/client'

const SCORE_MATCHED = 0.5

export type MatchStatus = 'matched' | 'ambiguous' | 'no_match'

export interface MatchResult {
  status: MatchStatus
  mensajeRespuesta: string
  matchedInvoiceId: number | null
  candidatas: MatchVoucherCandidate[]
  bestDestination: DestinationCandidate | null
}

function formatMonto(n: number): string {
  return `$${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/**
 * Match a voucher's extracted data against candidate invoices and destinations.
 * Invoice candidates are matched by nombre_origen (quien paga).
 * Destination candidates are matched by nombre_destino (quien cobra).
 * candidates should already be sorted by score descending.
 */
export function matchVoucher(args: {
  voucher: VoucherData
  candidates: MatchVoucherCandidate[]
  destinationCandidates: DestinationCandidate[]
}): MatchResult {
  const { voucher, candidates, destinationCandidates } = args
  const nombreOrigen = voucher.nombre_origen?.trim() || voucher.nombre_cliente?.trim() || null
  const nombreDestino = voucher.nombre_destino?.trim() || null

  // Best destination by score
  const bestDest = destinationCandidates.length > 0
    ? destinationCandidates.reduce((a, b) => (a.score >= b.score ? a : b))
    : null

  if (candidates.length === 0) {
    const msg = nombreOrigen
      ? `Buscamos facturas para "${nombreOrigen}" pero no encontramos ninguna pendiente que coincida con el monto. Un agente revisará tu comprobante.`
      : 'No encontramos facturas pendientes que coincidan con el comprobante. Un agente lo revisará.'
    return {
      status: 'no_match',
      mensajeRespuesta: msg,
      matchedInvoiceId: null,
      candidatas: [],
      bestDestination: bestDest,
    }
  }

  const monto = voucher.monto
  const byScore = [...candidates].sort((a, b) => b.score - a.score)
  const best = byScore[0]
  const montoOk = monto === null || monto <= 0 || Math.abs(monto - best.saldo_pendiente) <= 50

  if (best.score >= SCORE_MATCHED && montoOk) {
    const destMsg = bestDest
      ? ` El destino es ${bestDest.entity_type === 'PROVIDER' ? 'Proveedor' : 'Empleado'}: ${bestDest.entity_name}.`
      : ''
    const msg = nombreOrigen
      ? `Gracias ${nombreOrigen}. Tu pago de ${formatMonto(monto ?? best.saldo_pendiente)} corresponde a ${best.cliente_nombre} — Factura ${best.numero_factura} (saldo: ${formatMonto(best.saldo_pendiente)}).${destMsg} Lo estamos procesando.`
      : `Registramos tu pago de ${formatMonto(monto ?? best.saldo_pendiente)} para ${best.cliente_nombre} — Factura ${best.numero_factura}.${destMsg} Lo estamos procesando.`
    return {
      status: 'matched',
      mensajeRespuesta: msg,
      matchedInvoiceId: best.invoice_id,
      candidatas: [best],
      bestDestination: bestDest,
    }
  }

  // Ambiguous
  const lineas = byScore.map(
    (c, i) =>
      `${i + 1}. ${c.cliente_nombre} — Factura ${c.numero_factura} — Saldo: ${formatMonto(c.saldo_pendiente)}`,
  )
  const intro =
    nombreOrigen && byScore.some((c) => c.score > 0.2)
      ? `Encontramos diferentes clientes con saldos y nombres parecidos a "${nombreOrigen}". ¿Cuál es correcto?`
      : monto && monto > 0
        ? `Encontramos varias facturas con saldo cercano a ${formatMonto(monto)}. ¿A cuál corresponde tu pago?`
        : 'No pudimos identificar el cliente o el monto. Decinos el número de factura o el nombre del cliente.'

  return {
    status: 'ambiguous',
    mensajeRespuesta: intro + '\n\n' + lineas.join('\n') + '\n\nRespondé con el número de factura o el nombre completo.',
    matchedInvoiceId: null,
    candidatas: byScore,
    bestDestination: bestDest,
  }
}
