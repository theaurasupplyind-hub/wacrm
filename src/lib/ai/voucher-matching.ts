import type { VoucherData } from './voucher-extraction'
import type { MatchVoucherCandidate, DestinationCandidate } from '../facbal/client'

const MONTO_TOLERANCIA = 50
const MONTO_GAP_MIN = 10  // si el mejor está al menos $10 más cerca que el segundo, el monto decide
const NAME_MATCH_THRESHOLD = 0.5

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

function montoDistance(monto: number, saldo: number): number {
  return Math.abs(monto - saldo)
}

/**
 * Match a voucher's extracted data against candidate invoices and destinations.
 *
 * Priority: monto primero, nombre después.
 * - Si 1 candidato dentro de tolerancia → matched automático.
 * - Si varios, el que esté claramente más cerca ($10 gap) gana por monto.
 * - Si montos muy cercanos, el nombre desempata.
 * - Sin monto → fallback a nombre.
 */
export function matchVoucher(args: {
  voucher: VoucherData
  candidates: MatchVoucherCandidate[]
  destinationCandidates: DestinationCandidate[]
}): MatchResult {
  const { voucher, candidates, destinationCandidates } = args
  const nombreOrigen = voucher.nombre_origen?.trim() || voucher.nombre_cliente?.trim() || null
  const monto = voucher.monto

  // Best destination by score
  const bestDest = destinationCandidates.length > 0
    ? destinationCandidates.reduce((a, b) => (a.score >= b.score ? a : b))
    : null

  if (candidates.length === 0) {
    const msg = nombreOrigen
      ? `Buscamos facturas para "${nombreOrigen}" pero no encontramos ninguna pendiente que coincida con el monto. Un agente revisará tu comprobante.`
      : 'No encontramos facturas pendientes que coincidan con el comprobante. Un agente lo revisará.'
    return { status: 'no_match', mensajeRespuesta: msg, matchedInvoiceId: null, candidatas: [], bestDestination: bestDest }
  }

  // ── Sin monto → fallback a nombre ──
  if (!monto || monto <= 0) {
    const byName = candidates.filter((c) => c.score >= NAME_MATCH_THRESHOLD).sort((a, b) => b.score - a.score)
    if (byName.length === 0) {
      return { status: 'no_match', mensajeRespuesta: 'No pudimos leer el monto del comprobante ni identificar al cliente.', matchedInvoiceId: null, candidatas: [], bestDestination: bestDest }
    }
    if (byName.length === 1) {
      return buildMatched(byName[0], nombreOrigen, monto, bestDest)
    }
    return buildAmbiguous(byName, nombreOrigen, monto)
  }

  // ── Con monto: filtrar por tolerancia ──
  const byMonto = candidates
    .filter((c) => montoDistance(monto, c.saldo_pendiente) <= MONTO_TOLERANCIA)
    .sort((a, b) => montoDistance(monto, a.saldo_pendiente) - montoDistance(monto, b.saldo_pendiente))

  if (byMonto.length === 0) {
    return { status: 'no_match', mensajeRespuesta: `Recibimos tu comprobante por ${formatMonto(monto)} pero no encontramos ninguna factura pendiente con ese saldo exacto. Un agente lo revisará.`, matchedInvoiceId: null, candidatas: [], bestDestination: bestDest }
  }

  if (byMonto.length === 1) {
    return buildMatched(byMonto[0], nombreOrigen, monto, bestDest)
  }

  // Múltiples candidatos dentro de tolerancia
  const best = byMonto[0]
  const next = byMonto[1]
  const bestDist = montoDistance(monto, best.saldo_pendiente)
  const nextDist = montoDistance(monto, next.saldo_pendiente)

  // Si el mejor está claramente más cerca ($10 gap), monto decide
  if (nextDist - bestDist >= MONTO_GAP_MIN) {
    return buildMatched(best, nombreOrigen, monto, bestDest)
  }

  // Montos similares → usar nombre para desempatar
  const byName = byMonto.filter((c) => c.score >= NAME_MATCH_THRESHOLD).sort((a, b) => b.score - a.score)
  if (byName.length === 1) {
    return buildMatched(byName[0], nombreOrigen, monto, bestDest)
  }

  // No hay un ganador claro → ambiguous
  return buildAmbiguous(byMonto, nombreOrigen, monto)
}

function buildMatched(best: MatchVoucherCandidate, nombreOrigen: string | null, monto: number | null, bestDest: DestinationCandidate | null): MatchResult {
  const destMsg = bestDest ? ` El destino es ${bestDest.entity_type === 'PROVIDER' ? 'Proveedor' : 'Empleado'}: ${bestDest.entity_name}.` : ''
  const msg = nombreOrigen
    ? `Gracias ${nombreOrigen}. Tu pago de ${formatMonto(monto ?? best.saldo_pendiente)} corresponde a ${best.cliente_nombre} — Factura ${best.numero_factura} (saldo: ${formatMonto(best.saldo_pendiente)}).${destMsg} Lo estamos procesando.`
    : `Registramos tu pago de ${formatMonto(monto ?? best.saldo_pendiente)} para ${best.cliente_nombre} — Factura ${best.numero_factura}.${destMsg} Lo estamos procesando.`
  return { status: 'matched', mensajeRespuesta: msg, matchedInvoiceId: best.invoice_id, candidatas: [best], bestDestination: bestDest }
}

function buildAmbiguous(byScore: MatchVoucherCandidate[], nombreOrigen: string | null, monto: number | null): MatchResult {
  const lineas = byScore.map((c, i) => `${i + 1}. ${c.cliente_nombre} — Factura ${c.numero_factura} — Saldo: ${formatMonto(c.saldo_pendiente)}`)
  const intro = nombreOrigen && byScore.some((c) => c.score > 0.2)
    ? `Encontramos diferentes clientes con saldos y nombres parecidos a "${nombreOrigen}". ¿Cuál es correcto?`
    : monto && monto > 0
      ? `Encontramos varias facturas con saldo cercano a ${formatMonto(monto)}. ¿A cuál corresponde tu pago?`
      : 'No pudimos identificar el cliente o el monto. Decinos el número de factura o el nombre del cliente.'
  return { status: 'ambiguous', mensajeRespuesta: intro + '\n\n' + lineas.join('\n') + '\n\nRespondé con el número de factura o el nombre completo.', matchedInvoiceId: null, candidatas: byScore, bestDestination: null }
}
