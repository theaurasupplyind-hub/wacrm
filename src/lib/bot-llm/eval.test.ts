import { describe, it, expect } from 'vitest'
import { evaluateIntentClassifier, formatIntentReport } from './eval'
import type { BotIntent } from './types'

describe('evaluateIntentClassifier', () => {
  it('calcula accuracy y matriz de confusión', async () => {
    const cases = [
      { text: 'a', expected: 'gasto' as BotIntent },
      { text: 'b', expected: 'gasto' as BotIntent },
      { text: 'c', expected: 'otro' as BotIntent },
    ]
    const classify = (text: string): BotIntent => (text === 'c' ? 'otro' : text === 'a' ? 'gasto' : 'voucher')
    const report = await evaluateIntentClassifier(cases, classify)
    expect(report.total).toBe(3)
    expect(report.correct).toBe(2)
    expect(report.accuracy).toBeCloseTo(2 / 3)
    expect(report.confusion.gasto).toEqual({ gasto: 1, voucher: 1 })
    expect(report.confusion.otro).toEqual({ otro: 1 })
    expect(report.misses).toHaveLength(1)
    expect(report.misses[0]).toEqual({ text: 'b', expected: 'gasto', predicted: 'voucher' })
  })

  it('reporte vacío no divide por cero', async () => {
    const report = await evaluateIntentClassifier([], () => 'otro')
    expect(report.accuracy).toBe(0)
  })

  it('formatIntentReport incluye misses', () => {
    const txt = formatIntentReport({
      total: 2,
      correct: 1,
      accuracy: 0.5,
      confusion: {},
      misses: [{ text: 'x', expected: 'gasto', predicted: 'otro' }],
    })
    expect(txt).toContain('1/2')
    expect(txt).toContain('"x"')
  })
})
