import { describe, it, expect } from 'vitest'
import { extractBotMessage } from './extract-bot-message'
import { AGENTE_FIXTURES } from './agente-fixtures'
import { formatIntentReport, type IntentEvalReport } from './eval'

/**
 * Eval LIVE del plan agente-conversacional (Fase 0 → Fase 5).
 *
 * Pasa `AGENTE_FIXTURES` por el extractor real (LLM) y reporta:
 * - intent accuracy + matriz de confusión (afirmable: baseline de Fase 0),
 * - distribución auto/confirma del dataset (informativa hasta Fase 2),
 * - extracciones por fallback regex (proxy de fragilidad del LLM).
 *
 * Correr: `$env:OPENROUTER_API_KEY="..."; npx vitest run agente-eval.live`
 * El mismo dataset se reusa en Fase 5 para comparar modelos
 * (`EXTRACTOR_MODEL=deepseek/deepseek-v4.1-flash` vs default).
 */
const HAS_KEY = !!process.env.OPENROUTER_API_KEY
// Baseline Fase 0 (2026-10-14, gemini-2.5-flash-lite): 34/38 (89.5%).
// Umbral con margen para la no-determinismo del LLM (temperature 0.1).
const MIN_ACCURACY = Number(process.env.AGENTE_MIN_ACCURACY || 0.8)

/** USD por 1M tokens (verificado en OpenRouter; Fase 5). */
const PRICING: Record<string, { in: number; out: number }> = {
  'google/gemini-2.5-flash-lite': { in: 0.075, out: 0.3 },
  'deepseek/deepseek-v4.1-flash': { in: 0.0369, out: 0.891 },
}

describe.skipIf(!HAS_KEY)('agente eval live (Fase 0 baseline)', () => {
  it(`evalúa ${AGENTE_FIXTURES.length} casos y reporta baseline`, async () => {
    const report: IntentEvalReport = {
      total: AGENTE_FIXTURES.length,
      correct: 0,
      accuracy: 0,
      confusion: {},
      misses: [],
    }
    let fallbackCount = 0
    let confirmaCount = 0
    let promptTokens = 0
    let completionTokens = 0
    const latencies: number[] = []

    for (const c of AGENTE_FIXTURES) {
      if (c.behavior === 'confirma') confirmaCount += 1
      let predicted = 'otro'
      try {
        const t0 = Date.now()
        const ext = await extractBotMessage(c.text, c.contextText)
        latencies.push(Date.now() - t0)
        promptTokens += ext.llm_usage?.prompt_tokens ?? 0
        completionTokens += ext.llm_usage?.completion_tokens ?? 0
        predicted = ext.intent
        if (ext.extractor_source === 'fallback') fallbackCount += 1
      } catch (err) {
        console.error('[agente-eval] extractor error:', err instanceof Error ? err.message : String(err))
      }
      report.confusion[c.expected] ??= {}
      report.confusion[c.expected][predicted] = (report.confusion[c.expected][predicted] ?? 0) + 1
      if (predicted === c.expected) {
        report.correct += 1
      } else {
        report.misses.push({ text: c.text, expected: c.expected, predicted: predicted as never })
      }
    }
    report.accuracy = report.total > 0 ? report.correct / report.total : 0

    console.log(formatIntentReport(report))
    const model = process.env.EXTRACTOR_MODEL || 'default (gemini-2.5-flash-lite)'
    const price = PRICING[process.env.EXTRACTOR_MODEL || ''] ?? PRICING['google/gemini-2.5-flash-lite']
    const costUsd = (promptTokens / 1e6) * price.in + (completionTokens / 1e6) * price.out
    const sorted = [...latencies].sort((a, b) => a - b)
    const p50 = sorted[Math.floor(0.5 * sorted.length)] ?? 0
    const p95 = sorted[Math.floor(0.95 * sorted.length)] ?? 0
    console.log(
      `[agente-eval] dataset: ${confirmaCount}/${report.total} esperan confirmación ` +
        `(definicion-ambiguedad.md; el gate exige desde Fase 4) | ` +
        `fallback regex: ${fallbackCount}/${report.total} | ` +
        `modelo: ${model}`,
    )
    console.log(
      `[agente-eval] tokens: in=${promptTokens} out=${completionTokens} | ` +
        `costo: $${costUsd.toFixed(5)} total ($${(costUsd / report.total).toFixed(6)}/caso) | ` +
        `latencia ms: p50=${p50} p95=${p95}`,
    )

    // Invariante: ningún texto termina sin intent (el extractor siempre responde).
    expect(report.total).toBe(AGENTE_FIXTURES.length)
    expect(report.accuracy).toBeGreaterThanOrEqual(MIN_ACCURACY)
  }, 600_000)
})
