/**
 * Replay de `voucher_extractions`: re-evalúa el fix de `sanitizeClientName`
 * sobre los nombres que el extractor devolvió (guardados en `debug_info`),
 * sin volver a llamar a la IA ni al backend de facturas.
 *
 * Mide cuántos "nombres basura" (filenames como "Comprobante.pdf") ahora se
 * rechazan y cuántos comprobantes que quedaron en `no_match`/`ambiguous`
 * tenían ese problema.
 */

import { sanitizeClientName } from './voucher-matching'

const FILENAME_RE = /\.(pdf|jpe?g|png|webp|gif|bmp|tiff?|docx?|xlsx?|csv|txt)$/i

export interface VoucherReplayRow {
  message_id: string
  match_status: string
  debug_info: Record<string, unknown> | null
}

/** Reúne todos los nombres de cliente que el extractor devolvió en el debug. */
export function collectExtractedNames(debug: Record<string, unknown> | null): string[] {
  if (!debug) return []
  const out: string[] = []
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) out.push(v.trim())
  }
  const phase3 = debug.phase3 as { apiCall?: Record<string, unknown> } | undefined
  const phase2 = debug.phase2 as { apiCall?: Record<string, unknown> } | undefined
  push(phase3?.apiCall?.nombre_cliente)
  push(phase3?.apiCall?.nombre_origen)
  push(phase3?.apiCall?.nombre_destino)
  push(phase2?.apiCall?.nombre_destino)
  push(debug.invalidClientName)
  push(debug.invalidOriginName)
  push(debug.forcedCaption)
  return [...new Set(out)]
}

export interface VoucherReplayCase {
  messageId: string
  matchStatus: string
  names: string[]
  /** Nombres que ahora rechaza `sanitizeClientName`. */
  rejectedNow: string[]
  /** Nombres con pinta de archivo (el bug raíz de Fase 3). */
  filenameLike: string[]
}

export function analyzeVoucherRow(row: VoucherReplayRow): VoucherReplayCase {
  const names = collectExtractedNames(row.debug_info)
  const rejectedNow = names.filter((n) => n.length >= 3 && sanitizeClientName(n) === null)
  const filenameLike = names.filter((n) => FILENAME_RE.test(n))
  return {
    messageId: row.message_id,
    matchStatus: row.match_status,
    names,
    rejectedNow,
    filenameLike,
  }
}

export interface VoucherReplayReport {
  total: number
  namesConsidered: number
  rejectedNow: number
  filenameLike: number
  /** Filas no_match/ambiguous que traían al menos un nombre basura. */
  unresolvedWithJunk: number
  cases: VoucherReplayCase[]
}

export function summarizeVoucherReplay(cases: VoucherReplayCase[]): VoucherReplayReport {
  const allNames = cases.flatMap((c) => c.names)
  return {
    total: cases.length,
    namesConsidered: allNames.length,
    rejectedNow: cases.reduce((s, c) => s + c.rejectedNow.length, 0),
    filenameLike: cases.reduce((s, c) => s + c.filenameLike.length, 0),
    unresolvedWithJunk: cases.filter(
      (c) =>
        (c.matchStatus === 'no_match' || c.matchStatus === 'ambiguous') &&
        c.rejectedNow.length > 0,
    ).length,
    cases,
  }
}

export function formatVoucherReplayReport(report: VoucherReplayReport): string {
  const lines: string[] = []
  lines.push(
    `Voucher replay: ${report.total} filas · ${report.namesConsidered} nombres · ` +
      `rechazados ahora ${report.rejectedNow} · filenames ${report.filenameLike} · ` +
      `no_match/ambiguous con basura ${report.unresolvedWithJunk}`,
  )
  const filenames = report.cases.flatMap((c) => c.filenameLike)
  if (filenames.length > 0) {
    lines.push('Nombres con pinta de archivo (ahora rechazados):')
    for (const n of filenames.slice(0, 30)) lines.push(`  - "${n}"`)
  }
  return lines.join('\n')
}
