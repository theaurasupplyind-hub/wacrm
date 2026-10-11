import { describe, it, expect } from 'vitest'
import { analyzeVoucherRow, summarizeVoucherReplay, formatVoucherReplayReport } from './voucher-replay'
import { loadVoucherExtractions } from '@/lib/bot-llm/replay-fixtures'
import { sanitizeClientName } from './voucher-matching'

/**
 * Replay determinístico de vouchers: valida que los nombres basura
 * (filenames) que el extractor devolvió en los logs reales ahora se rechacen.
 */
const rows = loadVoucherExtractions()
const cases = rows.map((r) =>
  analyzeVoucherRow({
    message_id: r.message_id,
    match_status: r.match_status,
    debug_info: r.debug_info,
  }),
)

describe.skipIf(rows.length === 0)('replay determinístico (voucher_extractions)', () => {
  it('carga el fixture de voucher_extractions', () => {
    expect(rows.length).toBeGreaterThan(0)
  })

  it('todo nombre con pinta de archivo se rechaza con el sanitize nuevo', () => {
    const report = summarizeVoucherReplay(cases)
    console.log(formatVoucherReplayReport(report))
    for (const c of cases) {
      for (const name of c.filenameLike) {
        expect(sanitizeClientName(name)).toBeNull()
      }
    }
  })
})
