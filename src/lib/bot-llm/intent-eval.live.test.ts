import { describe, it, expect } from 'vitest'
import { extractBotMessage } from './extract-bot-message'
import { evaluateIntentClassifier, formatIntentReport } from './eval'
import { INTENT_FIXTURES } from './intent-fixtures'

/**
 * Evaluación LIVE del clasificador real (LLM). Solo corre cuando hay
 * OPENROUTER_API_KEY; en CI sin key se saltea. Es el guard de calidad de
 * intents: si la accuracy cae por debajo del umbral, falla.
 *
 * Correr: `OPENROUTER_API_KEY=... npx vitest run intent-eval.live`
 */
const HAS_KEY = !!process.env.OPENROUTER_API_KEY
const MIN_ACCURACY = 0.8

describe.skipIf(!HAS_KEY)('intent eval (live LLM)', () => {
  it(`accuracy >= ${MIN_ACCURACY * 100}% sobre el golden set`, async () => {
    const report = await evaluateIntentClassifier(INTENT_FIXTURES, async (text) => {
      const r = await extractBotMessage(text)
      return r.intent
    })
    console.log(formatIntentReport(report))
    expect(report.accuracy).toBeGreaterThanOrEqual(MIN_ACCURACY)
  }, 120_000)
})
