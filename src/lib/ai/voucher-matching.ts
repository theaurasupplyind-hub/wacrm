import type { VoucherData } from './voucher-extraction'
import type { MatchVoucherCandidate, DestinationCandidate } from '../facbal/client'

const MONTO_TOLERANCIA = 50
const MONTO_GAP_MIN = 10
const NAME_MATCH_THRESHOLD = 0.5

export type MatchStatus = 'matched' | 'ambiguous' | 'no_match' | 'multi_invoice'

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

export function findClientMatches(
  monto: number,
  candidates: MatchVoucherCandidate[],
): { clientName: string; invoices: MatchVoucherCandidate[]; total: number }[] {
  const groups = new Map<string, MatchVoucherCandidate[]>()
  for (const c of candidates) {
    const key = c.cliente_nombre?.trim().toLowerCase() || 'sin nombre'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(c)
  }

  const results: { clientName: string; invoices: MatchVoucherCandidate[]; total: number }[] = []
  for (const [_, invoices] of groups) {
    const total = invoices.reduce((s, inv) => s + inv.saldo_pendiente, 0)
    if (montoDistance(monto, total) <= MONTO_TOLERANCIA) {
      results.push({
        clientName: invoices[0].cliente_nombre || 'Sin nombre',
        invoices,
        total,
      })
    }
  }

  return results.sort((a, b) => montoDistance(monto, a.total) - montoDistance(monto, b.total))
}

export function matchVoucher(args: {
  voucher: VoucherData
  candidates: MatchVoucherCandidate[]
  destinationCandidates: DestinationCandidate[]
}): MatchResult {
  const { voucher, candidates, destinationCandidates } = args
  const nombreOrigen = voucher.nombre_origen?.trim() || voucher.nombre_cliente?.trim() || null
  const monto = voucher.monto

  const bestDest = destinationCandidates.length > 0
    ? destinationCandidates.reduce((a, b) => (a.score >= b.score ? a : b))
    : null

  if (candidates.length === 0) {
    const msg = nombreOrigen
      ? `Buscamos facturas para "${nombreOrigen}" pero no encontramos ninguna pendiente. Un agente revisará tu comprobante.`
      : 'No encontramos facturas pendientes. Un agente lo revisará.'
    return { status: 'no_match', mensajeRespuesta: msg, matchedInvoiceId: null, candidatas: [], bestDestination: bestDest }
  }

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

  const byMonto = candidates
    .filter((c) => monto <= c.saldo_pendiente + MONTO_TOLERANCIA)
    .sort((a, b) => {
      const da = montoDistance(monto, a.saldo_pendiente)
      const db = montoDistance(monto, b.saldo_pendiente)
      return da !== db ? da - db : b.score - a.score
    })

  if (byMonto.length === 0) {
    const msg = `Recibimos tu comprobante por ${formatMonto(monto)} pero no encontramos ninguna factura pendiente que coincida. Un agente lo revisará.`
    return { status: 'no_match', mensajeRespuesta: msg, matchedInvoiceId: null, candidatas: [], bestDestination: bestDest }
  }

  if (byMonto.length === 1) {
    const best = byMonto[0]
    if (monto > best.saldo_pendiente + MONTO_TOLERANCIA) {
      const others = candidates.filter((c) => c.invoice_id !== best.invoice_id && c.saldo_pendiente > 0)
      if (others.length > 0) {
        return buildMultiInvoice([best, ...others], best.cliente_nombre || 'Cliente', monto)
      }
    }
    return buildMatched(best, nombreOrigen, monto, bestDest)
  }

  const best = byMonto[0]
  const next = byMonto[1]
  const bestDist = montoDistance(monto, best.saldo_pendiente)
  const nextDist = montoDistance(monto, next.saldo_pendiente)

  if (nextDist - bestDist >= MONTO_GAP_MIN) {
    if (monto > best.saldo_pendiente + MONTO_TOLERANCIA) {
      const overCandidates = candidates.filter((c) => c.invoice_id !== best.invoice_id && c.saldo_pendiente > 0)
      if (overCandidates.length > 0) {
        return buildMultiInvoice([best, ...overCandidates], best.cliente_nombre || 'Cliente', monto)
      }
    }
    return buildMatched(best, nombreOrigen, monto, bestDest)
  }

  const byName = byMonto.filter((c) => c.score >= NAME_MATCH_THRESHOLD).sort((a, b) => b.score - a.score)
  if (byName.length === 1) {
    return buildMatched(byName[0], nombreOrigen, monto, bestDest)
  }

  return buildAmbiguous(byMonto, nombreOrigen, monto)
}

function buildMatched(best: MatchVoucherCandidate, nombreOrigen: string | null, monto: number | null, bestDest: DestinationCandidate | null): MatchResult {
  const destMsg = bestDest ? ` El destino es ${bestDest.entity_type === 'PROVIDER' ? 'Proveedor' : 'Empleado'}: ${bestDest.entity_name}.` : ''
  const esParcial = monto && monto < best.saldo_pendiente - 10
  const saldoRestante = esParcial ? ` Queda un saldo pendiente de ${formatMonto(best.saldo_pendiente - monto)}.` : ''
  const msg = nombreOrigen
    ? `Gracias ${nombreOrigen}. Tu pago de ${formatMonto(monto ?? best.saldo_pendiente)} corresponde a ${best.cliente_nombre} — Factura ${best.numero_factura} (saldo: ${formatMonto(best.saldo_pendiente)}).${saldoRestante}${destMsg} Lo estamos procesando.`
    : `Registramos tu pago de ${formatMonto(monto ?? best.saldo_pendiente)} para ${best.cliente_nombre} — Factura ${best.numero_factura}.${saldoRestante}${destMsg} Lo estamos procesando.`
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

function buildMultiInvoice(byScore: MatchVoucherCandidate[], clientName: string, monto: number): MatchResult {
  const lineas = byScore.map((c, i) => `${i + 1}. ${c.cliente_nombre} — Factura ${c.numero_factura} — Saldo: ${formatMonto(c.saldo_pendiente)}`)
  const intro = `Tu pago de ${formatMonto(monto)} coincide con el saldo total de ${clientName}. ¿Confirmás que querés pagar estas facturas?\n\n${lineas.join('\n')}\n\nRespondé "si", "confirmar" o los números de factura separados por coma.`
  return {
    status: 'multi_invoice',
    mensajeRespuesta: intro,
    matchedInvoiceId: null,
    candidatas: byScore,
    bestDestination: null,
  }
}
