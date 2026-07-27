import type { MatchVoucherCandidate } from '../facbal/client'

export const NAME_MATCH_THRESHOLD = 0.5

export function getMontoTolerancia(monto: number): number {
  return Math.max(50, monto * 0.03)
}

export function getMontoGapMin(monto: number): number {
  return Math.max(10, monto * 0.005)
}

export type MatchStatus = 'matched' | 'ambiguous' | 'no_match' | 'multi_invoice'

export function montoDistance(monto: number, saldo: number): number {
  return Math.abs(monto - saldo)
}

function findExactSubsetSum(
  target: number,
  invoices: MatchVoucherCandidate[],
): MatchVoucherCandidate[] | null {
  // For small n (<=15), try all subsets via bitmask
  if (invoices.length > 15) return null
  const total = invoices.reduce((s, inv) => s + inv.saldo_pendiente, 0)
  if (montoDistance(target, total) === 0) return null // full group match handled separately

  for (let mask = 1; mask < (1 << invoices.length); mask++) {
    let sum = 0
    const subset: MatchVoucherCandidate[] = []
    for (let i = 0; i < invoices.length; i++) {
      if (mask & (1 << i)) {
        sum += invoices[i].saldo_pendiente
        subset.push(invoices[i])
        if (sum > target) break
      }
    }
    if (sum === target) return subset
  }
  return null
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
  for (const invoices of groups.values()) {
    const total = invoices.reduce((s, inv) => s + inv.saldo_pendiente, 0)
    if (montoDistance(monto, total) === 0) {
      results.push({
        clientName: invoices[0].cliente_nombre || 'Sin nombre',
        invoices,
        total,
      })
    }
    // Try subset sum (partial payment of multiple invoices)
    const subset = findExactSubsetSum(monto, invoices)
    if (subset) {
      const subTotal = subset.reduce((s, inv) => s + inv.saldo_pendiente, 0)
      results.push({
        clientName: subset[0].cliente_nombre || 'Sin nombre',
        invoices: subset,
        total: subTotal,
      })
    }
  }
  return results.sort((a, b) => montoDistance(monto, a.total) - montoDistance(monto, b.total))
}
