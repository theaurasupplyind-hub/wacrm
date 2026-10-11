import { describe, it, expect } from 'vitest'
import { extractBotMessage } from './extract-bot-message'
import { replayRow, summarizeReplay, formatReplayReport, isTextReplayable } from './replay'
import { loadRouterLogs } from './replay-fixtures'

/**
 * Replay LIVE end-to-end: repite los mensajes de texto reales de `router_logs`
 * por el extractor real (LLM) + router, y compara contra lo logueado.
 *
 * Correr: `OPENROUTER_API_KEY=... npx vitest run replay.live`
 * Muestreo: `REPLAY_LIMIT=100` (default). Costo: 1 llamada LLM por caso.
 */
const HAS_KEY = !!process.env.OPENROUTER_API_KEY
const LIMIT = Number(process.env.REPLAY_LIMIT || 100)
const MIN_ACCURACY = Number(process.env.REPLAY_MIN_ACCURACY || 0.6)

const rows = loadRouterLogs().filter(isTextReplayable).slice(0, LIMIT)

describe.skipIf(!HAS_KEY || rows.length === 0)('replay live (LLM end-to-end)', () => {
  it(`repite ${rows.length} mensajes reales y reporta arreglos`, async () => {
    expect(rows.length).toBeGreaterThan(0)

    const cases = []
    for (const row of rows) {
      let extraction = null
      try {
        extraction = await extractBotMessage(row.raw_text!, row.context_text ?? undefined)
      } catch (err) {
        console.error('[replay] extractor error:', err instanceof Error ? err.message : String(err))
      }
      cases.push(replayRow(row, extraction))
    }

    const report = summarizeReplay(cases)
    console.log(formatReplayReport(report))

    // Invariante crítica del fix "nunca mudo": ningún texto termina en none.
    expect(report.silencesRemaining).toBe(0)
    // El intent del LLM actual debe coincidir con lo logueado en la mayoría
    // de los casos (umbral laxo por ser datos reales, ajustable por env).
    expect(report.intentAccuracy).toBeGreaterThanOrEqual(MIN_ACCURACY)
  }, 600_000)
})
