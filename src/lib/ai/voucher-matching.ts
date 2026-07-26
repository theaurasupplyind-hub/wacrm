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
