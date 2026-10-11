import { describe, it, expect } from 'vitest'
import { replayRow, summarizeReplay, formatReplayReport, isTextReplayable } from './replay'
import { loadRouterLogs, storedExtraction } from './replay-fixtures'

/**
 * Replay determinístico: usa la extracción YA guardada en `debug_info` (sin
 * LLM). Valida el arnés contra el router actual y detecta silencios que el
 * nuevo código ya no produce. No cubre el gate de whitelist ni el fallback de
 * media (viven en el webhook) — ver tests aparte.
 */
const rows = loadRouterLogs().filter(isTextReplayable)

describe.skipIf(rows.length === 0)('replay determinístico (router_logs)', () => {
  it('carga el fixture de router_logs', () => {
    expect(rows.length).toBeGreaterThan(0)
  })

  it('no deja ningún texto en dispatched_to=none', () => {
    const report = summarizeReplay(rows.map((r) => replayRow(r, storedExtraction(r))))
    console.log(formatReplayReport(report))
    expect(report.silencesRemaining).toBe(0)
  })

  it('no convierte en silencio un mensaje que antes se atendía', () => {
    const newSilences: string[] = []
    for (const row of rows) {
      const c = replayRow(row, storedExtraction(row))
      if (c.oldDispatch !== 'none' && c.newDispatch === 'none') {
        newSilences.push(`"${c.rawText.slice(0, 50)}" ${c.oldDispatch} → none`)
      }
    }
    expect(newSilences).toEqual([])
  })
})
