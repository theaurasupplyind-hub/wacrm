import type { MatchVoucherCandidate } from '../facbal/client'

export const NAME_MATCH_THRESHOLD = 0.5

export function getMontoTolerancia(monto: number): number {
  return Math.max(50, monto * 0.03)
}

export function getMontoGapMin(monto: number): number {
  return Math.max(10, monto * 0.005)
}

export type MatchStatus = 'matched' | 'ambiguous' | 'no_match' | 'multi_invoice'

/**
 * Nombres que nunca son un cliente real: el extractor de vouchers a veces
 * devuelve palabras del comprobante ("Gracias!", "Comprobante") como
 * nombre_cliente. Si no se filtran, el match por nombre falla y el pago
 * termina en "no encontramos ninguna factura" aunque el voucher traiga
 * el cliente real en otro campo (origen/destino).
 */
const INVALID_CLIENT_NAMES = new Set([
  'gracias', 'hola', 'buenas', 'buenos dias', 'buenas tardes', 'buenas noches',
  'comprobante', 'pago', 'pagar', 'pagado', 'transferencia', 'transferido',
  'deposito', 'factura', 'saldo', 'total', 'importe', 'alias', 'cbu',
])

/**
 * Nombres que son en realidad nombres de archivo del comprobante
 * ("Comprobante.pdf", "IMG_1234.jpg"). El extractor a veces los devuelve
 * como nombre_cliente; nunca son un cliente real.
 */
const FILENAME_RE = /\.(pdf|jpe?g|png|webp|gif|bmp|tiff?|docx?|xlsx?|csv|txt)$/i

/**
 * Forma compacta (solo letras/dígitos) de palabras basura: cubre variantes
 * pegadas como "comprobantepdf" (de "Comprobante.pdf").
 */
const INVALID_COMPACT = new Set([
  'comprobante', 'comprobantepdf', 'comprobantejpg', 'comprobantejpeg',
  'comprobantepng', 'comprobantewebp', 'gracias', 'factura', 'transferencia',
  'pago', 'pagado', 'deposito', 'saldo', 'total', 'importe', 'alias', 'cbu',
])

export function sanitizeClientName(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim()
  if (v.length < 3) return null
  // Nombre de archivo (con extensión) → nunca es un cliente.
  if (FILENAME_RE.test(v)) return null
  const norm = v
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[!¡?¿.,;:()[\]"]/g, '')
    .trim()
  if (!norm || INVALID_CLIENT_NAMES.has(norm)) return null
  // Variantes pegadas ("comprobantepdf") y nombres con dígitos no son clientes.
  const compact = norm.replace(/[^a-z0-9]/g, '')
  if (INVALID_COMPACT.has(compact)) return null
  if (/[0-9]/.test(norm)) return null
  return v
}

/**
 * Sticky Fase 1 (testeable): si al final no se encontró nada pero hay UN
 * único exacto por monto, se entrega. Con 0 o 2+ exactos, pool no vacío,
 * o resultado distinto de no_match → null (se mantiene lo decidido).
 */
export function pickStickyExact<T>(
  phase1Exact: T[],
  matchStatus: MatchStatus,
  poolSize: number,
): T | null {
  if (matchStatus === 'no_match' && poolSize === 0 && phase1Exact.length === 1) {
    return phase1Exact[0]
  }
  return null
}

export function montoDistance(monto: number, saldo: number): number {
  return Math.abs(monto - saldo)
}

/**
 * Normaliza un nombre para comparar captions (minúsculas, sin tildes).
 */
export function normalizeCaption(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim()
}

/**
 * ¿El nombre escrito en el caption matchea el cliente de una factura?
 * Tolera coincidencia parcial ("Jesus" vs "Jesus Daniel") y por tokens.
 */
export function captionMatchesClient(caption: string, cliente: string): boolean {
  const cap = normalizeCaption(caption)
  const cli = normalizeCaption(cliente)
  if (!cap || !cli) return false
  if (cli.includes(cap) || cap.includes(cli)) return true
  const capTokens = cap.split(/\s+/).filter(Boolean)
  const cliTokens = cli.split(/\s+/).filter(Boolean)
  if (capTokens.length === 0 || cliTokens.length === 0) return false
  return capTokens.every((t) => cliTokens.some((c) => c.includes(t) || t.includes(c)))
}

/**
 * Match de nombre FUERTE: el backend le dio al candidato un score suficiente
 * como para pagar sin preguntar (en efectivo).
 */
export function isStrongNameMatch(candidate: MatchVoucherCandidate): boolean {
  return candidate.score >= NAME_MATCH_THRESHOLD
}

/**
 * Match de nombre (score del backend O coincidencia local de tokens/prefijo).
 *
 * El backend es estricto con nombres cortos o apodos: "Ale" contra "Ale
 * Casagrande" vuelve con score 0.35 y se perdía la única factura. La
 * coincidencia local rescata ese caso, pero NO alcanza para pagar sola: el
 * pipeline trata un match débil (score < 0.5) como "confirmar antes de pagar".
 */
export function isNameMatch(
  name: string | null | undefined,
  candidate: MatchVoucherCandidate,
): boolean {
  if (isStrongNameMatch(candidate)) return true
  if (!name) return false
  return captionMatchesClient(name, candidate.cliente_nombre)
}

/**
 * Candidatos de una búsqueda por nombre, con match fuerte o local, ordenados
 * por score. No filtra por monto: lo decide el caller.
 */
export function selectNameCandidates(
  name: string,
  candidates: MatchVoucherCandidate[],
): MatchVoucherCandidate[] {
  return candidates
    .filter((c) => c.saldo_pendiente > 0 && isNameMatch(name, c))
    .sort((a, b) => b.score - a.score)
}


/**
 * El caption es una preferencia, nunca un veto: si algún item matchea el
 * caption se devuelven solo esos; si ninguno matchea, se devuelve la lista
 * completa (evita dejar el pool vacío y perder montos exactos).
 */
export function preferByCaption<T>(
  items: T[],
  caption: string | null | undefined,
  nameOf: (item: T) => string,
): T[] {
  if (!caption || items.length === 0) return items
  const filtered = items.filter((item) => captionMatchesClient(caption, nameOf(item)))
  return filtered.length > 0 ? filtered : items
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
