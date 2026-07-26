import type { VoucherData } from './voucher-extraction'
import type { MatchVoucherCandidate, DestinationCandidate } from '../facbal/client'

export const NAME_MATCH_THRESHOLD = 0.5

export function getMontoTolerancia(monto: number): number {
  return Math.max(50, monto * 0.03)
}

export function getMontoGapMin(monto: number): number {
  return Math.max(10, monto * 0.005)
}

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

export function montoDistance(monto: number, saldo: number): number {
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
    if (montoDistance(monto, total) <= getMontoTolerancia(monto)) {
      results.push({
        clientName: invoices[0].cliente_nombre || 'Sin nombre',
        invoices,
        total,
      })
    }
  }

  return results.sort((a, b) => montoDistance(monto, a.total) - montoDistance(monto, b.total))
}

export function findExactClientSumMatches(
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
    if (montoDistance(monto, total) === 0) {
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

  console.log('[voucher-debug] === matchVoucher START ===')
  console.log('[voucher-debug]   candidates=%d, nombreOrigen="%s", monto=%s', candidates.length, nombreOrigen, monto)
  if (candidates.length > 0) {
    console.table(candidates.map(c => ({
      factura: c.numero_factura,
      cliente: c.cliente_nombre,
      saldo: c.saldo_pendiente,
      score: c.score,
    })))
  }

  if (candidates.length === 0) {
    console.log('[voucher-debug] → no_match (no candidates)')
    const msg = nombreOrigen
      ? `Buscamos facturas para "${nombreOrigen}" pero no encontramos ninguna pendiente. Un agente revisará tu comprobante.`
      : 'No encontramos facturas pendientes. Un agente lo revisará.'
    return { status: 'no_match', mensajeRespuesta: msg, matchedInvoiceId: null, candidatas: [], bestDestination: bestDest }
  }

  if (!monto || monto <= 0) {
    console.log('[voucher-debug] --- no monto, scoring only by name ---')
    const byName = candidates.filter((c) => c.score >= NAME_MATCH_THRESHOLD).sort((a, b) => b.score - a.score)
    if (byName.length === 0) {
      console.log('[voucher-debug] → no_match (no name match without monto)')
      return { status: 'no_match', mensajeRespuesta: 'No pudimos leer el monto del comprobante ni identificar al cliente.', matchedInvoiceId: null, candidatas: [], bestDestination: bestDest }
    }
    if (byName.length === 1) {
      console.log('[voucher-debug] → matched by name (monto unknown, factura=%s)', byName[0].numero_factura)
      return buildMatched(byName[0], nombreOrigen, monto, bestDest)
    }
    console.log('[voucher-debug] → ambiguous by name (monto unknown)')
    return buildAmbiguous(byName, nombreOrigen, monto)
  }

  const byMonto = candidates
    .filter((c) => monto <= c.saldo_pendiente + getMontoTolerancia(monto))
    .sort((a, b) => {
      const da = montoDistance(monto, a.saldo_pendiente)
      const db = montoDistance(monto, b.saldo_pendiente)
      return da !== db ? da - db : b.score - a.score
    })

  console.log('[voucher-debug] --- byMonto filter (monto=%s <= saldo + %s) ---', monto, getMontoTolerancia(monto))
  if (byMonto.length > 0) {
    console.table(byMonto.map(c => ({
      factura: c.numero_factura,
      cliente: c.cliente_nombre,
      saldo: c.saldo_pendiente,
      dist: montoDistance(monto, c.saldo_pendiente),
      score: c.score,
    })))
  } else {
    const rejected = candidates.filter(c => monto > c.saldo_pendiente + getMontoTolerancia(monto))
    console.log('[voucher-debug]   byMonto: 0 candidates')
    if (rejected.length > 0) {
      console.table(rejected.map(c => ({
        factura: c.numero_factura,
        cliente: c.cliente_nombre,
        saldo: c.saldo_pendiente,
        rechazo: `monto (${monto}) > saldo+${getMontoTolerancia(monto)} (${c.saldo_pendiente + getMontoTolerancia(monto)})`,
      })))
    }
  }

  if (byMonto.length === 0) {
    console.log('[voucher-debug] → no_match (byMonto empty)')
    const msg = `Recibimos tu comprobante por ${formatMonto(monto)} pero no encontramos ninguna factura pendiente que coincida. Un agente lo revisará.`
    return { status: 'no_match', mensajeRespuesta: msg, matchedInvoiceId: null, candidatas: [], bestDestination: bestDest }
  }

  if (byMonto.length === 1) {
    const best = byMonto[0]
    console.log('[voucher-debug] byMonto.length=1, dist=%s, factura=%s', montoDistance(monto, best.saldo_pendiente), best.numero_factura)
    if (monto > best.saldo_pendiente + getMontoTolerancia(monto)) {
      console.log('[voucher-debug]   monto > saldo+%s → checking multi-invoice', getMontoTolerancia(monto))
      const others = candidates.filter((c) => c.invoice_id !== best.invoice_id && c.saldo_pendiente > 0)
      if (others.length > 0) {
        console.log('[voucher-debug] → multi_invoice')
        return buildMultiInvoice([best, ...others], best.cliente_nombre || 'Cliente', monto)
      }
    }
    console.log('[voucher-debug] → matched')
    return buildMatched(best, nombreOrigen, monto, bestDest)
  }

  const best = byMonto[0]
  const next = byMonto[1]
  const bestDist = montoDistance(monto, best.saldo_pendiente)
  const nextDist = montoDistance(monto, next.saldo_pendiente)
  const gap = nextDist - bestDist

  console.log('[voucher-debug] --- disambiguation ---')
  console.log('[voucher-debug]   best=%s (cliente="%s", saldo=%s, dist=%s)', best.numero_factura, best.cliente_nombre, best.saldo_pendiente, bestDist)
  console.log('[voucher-debug]   next=%s (cliente="%s", saldo=%s, dist=%s)', next.numero_factura, next.cliente_nombre, next.saldo_pendiente, nextDist)
  console.log('[voucher-debug]   bestDist=%s, nextDist=%s, gap=%s', bestDist, nextDist, gap)
  console.log('[voucher-debug]   bestDist===0? %s | gap>=%s? %s', bestDist === 0 ? 'YES' : 'NO', getMontoGapMin(monto), gap >= getMontoGapMin(monto) ? 'YES' : 'NO')

  if (bestDist === 0) {
    console.log('[voucher-debug]   bestDist === 0 → exact match')
    if (byMonto.length > 1 && montoDistance(monto, byMonto[1].saldo_pendiente) === 0) {
      console.log('[voucher-debug]   multiple exact matches → disambiguate by name')
    } else {
      if (best.score >= NAME_MATCH_THRESHOLD) {
        if (monto > best.saldo_pendiente + getMontoTolerancia(monto)) {
          console.log('[voucher-debug]   monto > saldo+%s → checking multi-invoice', getMontoTolerancia(monto))
          const overCandidates = candidates.filter((c) => c.invoice_id !== best.invoice_id && c.saldo_pendiente > 0)
          if (overCandidates.length > 0) {
            console.log('[voucher-debug] → multi_invoice')
            return buildMultiInvoice([best, ...overCandidates], best.cliente_nombre || 'Cliente', monto)
          }
        }
        console.log('[voucher-debug] → matched (exact + name OK)')
        return buildMatched(best, nombreOrigen, monto, bestDest)
      }
      console.log('[voucher-debug]   name mismatch (score=%s < %s) → asking user', best.score, NAME_MATCH_THRESHOLD)
      console.log('[voucher-debug] → name_mismatch')
      return buildNameMismatch(best, nombreOrigen, monto, bestDest)
    }
  } else if (gap >= getMontoGapMin(monto)) {
    if (monto > best.saldo_pendiente + getMontoTolerancia(monto)) {
      console.log('[voucher-debug]   monto > saldo+%s → checking multi-invoice', getMontoTolerancia(monto))
      const overCandidates = candidates.filter((c) => c.invoice_id !== best.invoice_id && c.saldo_pendiente > 0)
      if (overCandidates.length > 0) {
        console.log('[voucher-debug] → multi_invoice')
        return buildMultiInvoice([best, ...overCandidates], best.cliente_nombre || 'Cliente', monto)
      }
    }
    console.log('[voucher-debug] → matched (gap/zero rule)')
    return buildMatched(best, nombreOrigen, monto, bestDest)
  }

  console.log('[voucher-debug] --- byName filter (score >= %s) ---', NAME_MATCH_THRESHOLD)
  console.table(byMonto.map(c => ({
    factura: c.numero_factura,
    cliente: c.cliente_nombre,
    saldo: c.saldo_pendiente,
    dist: montoDistance(monto, c.saldo_pendiente),
    score: c.score,
    pasaNombre: c.score >= NAME_MATCH_THRESHOLD ? 'SI' : 'NO',
  })))
  const byName = byMonto.filter((c) => c.score >= NAME_MATCH_THRESHOLD).sort((a, b) => b.score - a.score)
  if (byName.length === 1) {
    console.log('[voucher-debug] byName.length=1 → matched (factura=%s, score=%s)', byName[0].numero_factura, byName[0].score)
    return buildMatched(byName[0], nombreOrigen, monto, bestDest)
  }

  console.log('[voucher-debug] byName.length=%d → ambiguous', byName.length)
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

function buildNameMismatch(best: MatchVoucherCandidate, nombreOrigen: string | null, monto: number | null, bestDest: DestinationCandidate | null): MatchResult {
  const msg = nombreOrigen
    ? `El pago de ${formatMonto(monto ?? best.saldo_pendiente)} coincide exactamente con la factura ${best.numero_factura} de ${best.cliente_nombre}, pero el nombre del remitente es "${nombreOrigen}". ¿Es correcto?\n\nRespondé "sí" para confirmar o decinos el nombre correcto.`
    : `El pago de ${formatMonto(monto ?? best.saldo_pendiente)} coincide exactamente con la factura ${best.numero_factura} de ${best.cliente_nombre}. ¿Es correcto?\n\nRespondé "sí" para confirmar.`
  return { status: 'ambiguous', mensajeRespuesta: msg, matchedInvoiceId: null, candidatas: [best], bestDestination: bestDest }
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
