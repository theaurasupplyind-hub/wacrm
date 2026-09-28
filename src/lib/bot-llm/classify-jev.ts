/**
 * Clasificación auxiliar con Jev (System One) para el bot.
 *
 * Una sola llamada evalúa, en paralelo:
 *  - `intent` (choice, 9 opciones) — reemplaza/verifica la clasificación del LLM.
 *  - `pending_domain` (choice) — a qué pendiente responde el mensaje.
 *  - `answers_pending` (noul) — ¿responde a la pregunta pendiente?
 *  - `supersedes` (noul) — ¿es una orden nueva que reemplaza el pendiente?
 *
 * Nunca lanza: ante cualquier error devuelve `null` y el bot sigue con su
 * pipeline actual.
 */

import {
  callJev,
  isJevEnabled,
  isJevShadow,
  type JevAnswer,
  type JevQuestion,
  type JevUsage,
} from '@/lib/ai/jev'
import type { BotIntent, Confidence, UnifiedExtraction } from './types'

export type JevPendingDomain = 'expense' | 'attendance' | 'voucher' | 'voice' | 'none'

/**
 * Confianza mínima del intent de Jev para sobrescribir al LLM. Por debajo de
 * este umbral se conserva el intent del LLM (Jev queda solo como debug) para
 * no degradar casos ambiguos.
 */
export const JEV_OVERRIDE_MIN_CONFIDENCE = 0.6

export interface JevPendingSignal {
  domain: JevPendingDomain
  answersPending: number
  supersedes: number
}

export interface JevClassification {
  intent: BotIntent
  confidence: number
  probabilities: Record<string, number>
  pendingDomain: JevPendingDomain
  answersPending: number | null
  supersedes: number | null
  usage: JevUsage | null
}

export interface ClassifyJevArgs {
  text: string
  contextText?: string | null
  pendingDomains?: string[]
}

const VALID_INTENTS: BotIntent[] = [
  'asistencia_llegada',
  'asistencia_salida',
  'asistencia_estado',
  'gasto',
  'multi_expense',
  'voucher',
  'pedido',
  'factura',
  'otro',
]

const VALID_DOMAINS: JevPendingDomain[] = ['expense', 'attendance', 'voucher', 'voice', 'none']

const INTENT_CRITERIA: Record<string, string | null> = {
  asistencia_llegada: 'Llegada al trabajo ("llegó", "llegué", "buenos días").',
  asistencia_salida: 'Salida del trabajo ("me voy", "salí", "se fue", "terminé").',
  asistencia_estado: 'Vacaciones, licencia o ausencia de un empleado.',
  gasto: 'Registro de UN gasto del negocio (servicios, insumos, sueldos, proveedores).',
  multi_expense: 'DOS O MÁS gastos distintos en un mismo mensaje, cada uno con su monto.',
  voucher: 'Comprobante/pago de un cliente para pagar su factura ("Jo pagó en efectivo 2000").',
  pedido: 'El cliente quiere productos del taller/catálogo, presupuesto o precios.',
  factura: 'Consulta de facturas, deudas o saldos.',
  otro: 'Saludo, charla casual, mensaje irrelevante o que no completa ninguna intención.',
}

const PENDING_CRITERIA: Record<string, string | null> = {
  expense: 'El mensaje completa un gasto pendiente (monto, categoría, confirmación).',
  attendance: 'El mensaje completa una asistencia pendiente (hora, empleado, confirmación).',
  voucher: 'El mensaje responde a una aclaración de voucher (letra, número, cliente).',
  voice: 'El mensaje completa un pedido pendiente (variante, nombre de cliente, confirmación).',
  none: 'El mensaje no responde a ninguna pregunta pendiente.',
}

function todayAR(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' })
}

/** Confianza discreta derivada de la `confidence` calibrada de Jev. */
export function confidenceToConfianza(confidence: number): Confidence {
  if (confidence >= 0.75) return 'alta'
  if (confidence >= 0.45) return 'media'
  return 'baja'
}

function parseChoice(answer: JevAnswer | undefined): { choice: string; confidence: number; probabilities: Record<string, number> } | null {
  if (!answer || answer.type !== 'choice') return null
  return {
    choice: answer.choice,
    confidence: typeof answer.confidence === 'number' ? answer.confidence : 0,
    probabilities: answer.probabilities ?? {},
  }
}

function parseNoul(answer: JevAnswer | undefined): number | null {
  if (!answer || answer.type !== 'noul') return null
  return typeof answer.noul === 'number' ? answer.noul : null
}

function mapAnswers(answers: Record<string, JevAnswer>, usage: JevUsage | null): JevClassification {
  const intentChoice = parseChoice(answers.intent)
  const intent: BotIntent =
    intentChoice && VALID_INTENTS.includes(intentChoice.choice as BotIntent)
      ? (intentChoice.choice as BotIntent)
      : 'otro'

  const pendingChoice = parseChoice(answers.pending_domain)
  const pendingDomain: JevPendingDomain =
    pendingChoice && VALID_DOMAINS.includes(pendingChoice.choice as JevPendingDomain)
      ? (pendingChoice.choice as JevPendingDomain)
      : 'none'

  return {
    intent,
    confidence: intentChoice?.confidence ?? 0,
    probabilities: intentChoice?.probabilities ?? {},
    pendingDomain,
    answersPending: parseNoul(answers.answers_pending),
    supersedes: parseNoul(answers.supersedes),
    usage,
  }
}

/**
 * Clasifica un mensaje con Jev. Devuelve `null` si Jev está apagado o falla.
 */
export async function classifyWithJev(args: ClassifyJevArgs): Promise<JevClassification | null> {
  const text = (args.text || '').trim()
  if (!text) return null

  const questions: Record<string, JevQuestion> = {
    intent: {
      type: 'choice',
      instructions: '¿Cuál es la intención principal del mensaje del usuario?',
      criteria: INTENT_CRITERIA,
    },
    pending_domain: {
      type: 'choice',
      instructions:
        'Si el mensaje responde a una pregunta pendiente del bot (descripta en el contexto), ¿a qué dominio corresponde? Si no responde a ninguna, elegí "none".',
      criteria: PENDING_CRITERIA,
    },
    answers_pending: {
      type: 'noul',
      instructions:
        '¿El mensaje responde a la pregunta pendiente del bot (completar un gasto, una asistencia, un voucher o un pedido)?',
    },
    supersedes: {
      type: 'noul',
      instructions:
        '¿El mensaje es una orden nueva y completa que debe reemplazar o cancelar el pendiente, en vez de responderlo?',
    },
  }

  try {
    const result = await callJev({
      state: {
        mensaje: text,
        contexto_pendiente: args.contextText?.trim() || null,
        pendientes: args.pendingDomains && args.pendingDomains.length > 0 ? args.pendingDomains : [],
        fecha_hoy: todayAR(),
      },
      questions,
    })
    return mapAnswers(result.answers, result.usage)
  } catch (err) {
    console.error('[classifyJev] error:', err instanceof Error ? err.message : String(err))
    return null
  }
}

/**
 * Construye la señal de pendiente para el router a partir de una extracción.
 * Solo cuando Jev está activo y NO en shadow (es decir, cuando sus resultados
 * ya se usan para decidir).
 */
export function buildJevPending(e: UnifiedExtraction | null): JevPendingSignal | null {
  if (!e || !isJevEnabled() || isJevShadow()) return null
  if (e.jev_pending_domain == null || e.jev_answers_pending == null) return null
  return {
    domain: e.jev_pending_domain,
    answersPending: e.jev_answers_pending,
    supersedes: e.jev_supersedes ?? 0,
  }
}
