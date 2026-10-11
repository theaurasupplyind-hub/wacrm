import type { BotIntent } from './types'

/**
 * Arnés de evaluación de la detección de intents.
 *
 * Mide accuracy y matriz de confusión sobre un golden set. Es agnóstico del
 * clasificador (LLM, Jev, fallback o el pipeline completo): recibe una función
 * `classify(text) => intent`. Sirve para comparar cambios antes de mergear y
 * para calibrar umbrales con datos reales exportados de `router_logs`.
 */

export interface IntentCase {
  text: string
  expected: BotIntent
  /** Contexto multi-turn opcional (se pasa al clasificador). */
  contextText?: string
  note?: string
}

export interface IntentMiss {
  text: string
  expected: BotIntent
  predicted: BotIntent
}

export interface IntentEvalReport {
  total: number
  correct: number
  accuracy: number
  /** confusion[expected][predicted] = cantidad. */
  confusion: Record<string, Record<string, number>>
  misses: IntentMiss[]
}

export type IntentClassifier = (text: string, contextText?: string) => Promise<BotIntent> | BotIntent

export async function evaluateIntentClassifier(
  cases: IntentCase[],
  classify: IntentClassifier,
): Promise<IntentEvalReport> {
  const confusion: Record<string, Record<string, number>> = {}
  const misses: IntentMiss[] = []
  let correct = 0

  for (const c of cases) {
    const predicted = await classify(c.text, c.contextText)
    confusion[c.expected] ??= {}
    confusion[c.expected][predicted] = (confusion[c.expected][predicted] ?? 0) + 1
    if (predicted === c.expected) {
      correct += 1
    } else {
      misses.push({ text: c.text, expected: c.expected, predicted })
    }
  }

  return {
    total: cases.length,
    correct,
    accuracy: cases.length > 0 ? correct / cases.length : 0,
    confusion,
    misses,
  }
}

/** Formatea el reporte como texto legible para consola. */
export function formatIntentReport(report: IntentEvalReport): string {
  const lines: string[] = []
  lines.push(`Intent eval: ${report.correct}/${report.total} (${(report.accuracy * 100).toFixed(1)}%)`)
  if (report.misses.length > 0) {
    lines.push('Misses:')
    for (const m of report.misses) {
      lines.push(`  - "${m.text}" → esperado ${m.expected}, predijo ${m.predicted}`)
    }
  }
  return lines.join('\n')
}
