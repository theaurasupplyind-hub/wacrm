/**
 * Gate de efectos (Fase 2 del plan agente-conversacional).
 *
 * Módulo PURO (sin I/O): decide `auto` (auto-save) vs `confirma` para una
 * operación, implementando la definición de `docs/bots/definicion-ambiguedad.md`
 * (señales S1–S6). Regla madre: todo se auto-guarda salvo lectura ambigua.
 *
 * En Fase 2 las vías de escritura lo evalúan en SOMBRA (deciden igual que
 * antes, pero adjuntan `gate` al resultado y lo loguean). La exigencia real
 * llega en Fase 4 con el agente como vía principal.
 */
import type { UnifiedExtraction } from '@/lib/bot-llm/types'
import type { ExpenseFuzzyMatch } from '@/lib/expenses/types'
import { classifyPaymentIntent } from '@/lib/bot-llm/payment-intent'

export type AmbiguitySignal = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6'

/** Clase de operación a efectos del gate. */
export type OperationKind =
  | 'gasto'
  | 'asistencia'
  | 'factura'
  | 'pago'
  | 'pedido'
  | 'lectura'
  | 'otro'

/** Operaciones irreversibles o costosas: vara estricta (S6). */
export const STRICT_OPERATIONS: ReadonlySet<OperationKind> = new Set(['factura', 'pago', 'pedido'])

/** Margen mínimo top1-vs-top2 para considerar firme un match (S3). */
export const MATCH_MARGIN_MIN = 0.15

export interface MatchInfo {
  /** Gap top1-vs-top2 del mejor match de entidad (null si no hubo match). */
  margin?: number | null
  /** La entidad/categoría se crearía porque no existe. */
  isNewEntity?: boolean
  /** Campos obligatorios faltantes (además de los de la extracción). */
  missingFields?: string[]
}

export interface GateInput {
  text: string
  extraction: UnifiedExtraction | null
  operation: OperationKind
  match?: MatchInfo
}

export interface GateDecision {
  decision: 'auto' | 'confirma'
  reasons: AmbiguitySignal[]
  /** Preguntas puntuales para la confirmación (datos faltantes). */
  questions: string[]
}

/**
 * Deriva el `MatchInfo` del gate desde un fuzzy match (Fase 4: pre-match único).
 * - `margin`: menor gap entre (a) top1-top2 dentro de cada lista y (b) mejor
 *   proveedor vs mejor empleado (empate cruzado). null si no hubo candidatos.
 * - `isNewEntity`: nombre sin id (no matcheó nada existente) o categoría creada.
 */
export function deriveMatchInfo(match: ExpenseFuzzyMatch | null | undefined): MatchInfo {
  if (!match) return {}
  const gaps: number[] = []
  const best: Record<'provider' | 'employee', number> = { provider: 0, employee: 0 }
  for (const list of ['provider', 'employee'] as const) {
    const top = match.entityScores?.[list] ?? []
    if (top.length > 0) {
      best[list] = top[0].score
      gaps.push(top[0].score - (top[1]?.score ?? 0))
    }
  }
  if ((match.entityScores?.provider.length ?? 0) > 0 && (match.entityScores?.employee.length ?? 0) > 0) {
    gaps.push(Math.abs(best.provider - best.employee))
  }
  return {
    margin: gaps.length > 0 ? Math.min(...gaps) : null,
    isNewEntity:
      !!((match.providerName && !match.providerId) || (match.employeeName && !match.employeeId) || match.categoryWasCreated),
  }
}

function questionsForMissing(missing: string[]): string[] {
  return missing.map((f) => {
    switch (f) {
      case 'monto':
        return '¿Cuál es el monto?'
      case 'proveedor':
        return '¿Cuál es el proveedor?'
      case 'empleado':
        return '¿De qué empleado se trata?'
      case 'hora':
        return '¿A qué hora?'
      case 'categoria':
        return '¿A qué categoría lo asigno?'
      case 'cliente':
        return '¿Para qué cliente?'
      default:
        return `Falta el dato: ${f}.`
    }
  })
}

export function evaluateGate(input: GateInput): GateDecision {
  const reasons: AmbiguitySignal[] = []
  const questions: string[] = []
  const ext = input.extraction

  // Sin extracción no hay nada que guardar: no es ambiguo, es vacío.
  // El caller decide el fallback; el gate no bloquea.
  if (!ext) {
    return { decision: 'auto', reasons: [], questions: [] }
  }

  // S2: banda de pago pelada → siempre se aclara cobro vs gasto.
  if (classifyPaymentIntent(input.text) === 'ambiguous') {
    return {
      decision: 'confirma',
      reasons: ['S2'],
      questions: ['¿Te pagaron a vos o pagaste vos?'],
    }
  }

  // S1: confianza baja o dudoso en operación con efecto → confirma.
  if ((ext.confianza === 'baja' || ext.dudoso) && input.operation !== 'lectura' && input.operation !== 'otro') {
    reasons.push('S1')
  }

  // S3: match débil/empatado (solo si el caller aporta el margen; ver nota).
  if (input.match?.margin != null && input.match.margin < MATCH_MARGIN_MIN) {
    reasons.push('S3')
  }

  // S4: crearía entidad/categoría nueva.
  if (input.match?.isNewEntity) {
    reasons.push('S4')
  }

  // S5: campos obligatorios faltantes (extracción + aporte del caller).
  const missing = [...(ext.faltan_campos ?? []), ...(input.match?.missingFields ?? [])]
  if (missing.length > 0 && input.operation !== 'lectura' && input.operation !== 'otro') {
    reasons.push('S5')
    questions.push(...questionsForMissing(missing))
  }

  // S6: vara estricta en irreversibles sin confianza alta.
  if (STRICT_OPERATIONS.has(input.operation) && ext.confianza !== 'alta') {
    reasons.push('S6')
  }

  if (reasons.length > 0) {
    return { decision: 'confirma', reasons, questions }
  }
  return { decision: 'auto', reasons: [], questions: [] }
}
