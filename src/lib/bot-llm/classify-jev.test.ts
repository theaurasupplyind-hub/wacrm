import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { callJev } from '@/lib/ai/jev'
import { buildJevPending, classifyWithJev, confidenceToConfianza } from './classify-jev'
import type { UnifiedExtraction } from './types'

vi.mock('@/lib/ai/jev', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/jev')>()
  return { ...actual, callJev: vi.fn() }
})

const mockedCallJev = vi.mocked(callJev)

function mockAnswers(answers: Record<string, unknown>) {
  mockedCallJev.mockResolvedValueOnce({
    answers: answers as never,
    usage: { input_tokens: 10, output_tokens: 2 },
  })
}

const ENV_KEYS = ['JEV_ENABLED', 'JEV_SHADOW'] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  mockedCallJev.mockReset()
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('classifyWithJev', () => {
  it('mapea intent, dominio de pendiente y nouls', async () => {
    mockAnswers({
      intent: { type: 'choice', choice: 'gasto', probabilities: { gasto: 0.9, otro: 0.1 }, confidence: 0.88 },
      pending_domain: { type: 'choice', choice: 'expense', probabilities: { expense: 0.8 }, confidence: 0.7 },
      answers_pending: { type: 'noul', noul: 0.93 },
      supersedes: { type: 'noul', noul: 0.04 },
    })
    const r = await classifyWithJev({ text: '5000', contextText: 'Se espera el monto', pendingDomains: ['expense'] })
    expect(r).not.toBeNull()
    expect(r!.intent).toBe('gasto')
    expect(r!.confidence).toBeCloseTo(0.88)
    expect(r!.pendingDomain).toBe('expense')
    expect(r!.answersPending).toBeCloseTo(0.93)
    expect(r!.supersedes).toBeCloseTo(0.04)
    expect(r!.usage?.input_tokens).toBe(10)
  })

  it('intent fuera de rango cae a "otro"', async () => {
    mockAnswers({
      intent: { type: 'choice', choice: 'bailar', probabilities: {}, confidence: 0.5 },
      pending_domain: { type: 'choice', choice: 'nope', probabilities: {}, confidence: 0.5 },
      answers_pending: { type: 'noul', noul: 0.2 },
      supersedes: { type: 'noul', noul: 0.1 },
    })
    const r = await classifyWithJev({ text: 'asdf' })
    expect(r!.intent).toBe('otro')
    expect(r!.pendingDomain).toBe('none')
  })

  it('devuelve null si callJev falla (nunca rompe el pipeline)', async () => {
    mockedCallJev.mockRejectedValueOnce(new Error('boom'))
    const r = await classifyWithJev({ text: 'hola' })
    expect(r).toBeNull()
  })

  it('texto vacío no llama a Jev', async () => {
    const r = await classifyWithJev({ text: '   ' })
    expect(r).toBeNull()
    expect(mockedCallJev).not.toHaveBeenCalled()
  })
})

describe('confidenceToConfianza', () => {
  it('mapea umbrales', () => {
    expect(confidenceToConfianza(0.9)).toBe('alta')
    expect(confidenceToConfianza(0.5)).toBe('media')
    expect(confidenceToConfianza(0.2)).toBe('baja')
  })
})

describe('buildJevPending', () => {
  function extraction(overrides: Partial<UnifiedExtraction>): UnifiedExtraction {
    return {
      intent: 'otro',
      confianza: 'baja',
      extractor_source: 'llm',
      empleado: null,
      hora: null,
      estado: null,
      monto: null,
      categoria: null,
      tipo_gasto: null,
      saldo_pendiente: null,
      proveedor: null,
      empleado_gasto: null,
      destino: null,
      metodo_pago: null,
      fecha: null,
      faltan_campos: [],
      dudoso: false,
      razon_duda: null,
      raw: 'test',
      ...overrides,
    } as UnifiedExtraction
  }

  it('activo (enabled + no shadow) construye la señal', () => {
    process.env.JEV_ENABLED = 'true'
    process.env.JEV_SHADOW = 'false'
    const signal = buildJevPending(extraction({ jev_pending_domain: 'voucher', jev_answers_pending: 0.9, jev_supersedes: 0.1 }))
    expect(signal).toEqual({ domain: 'voucher', answersPending: 0.9, supersedes: 0.1 })
  })

  it('en shadow devuelve null', () => {
    process.env.JEV_ENABLED = 'true'
    process.env.JEV_SHADOW = 'true'
    expect(buildJevPending(extraction({ jev_pending_domain: 'voucher', jev_answers_pending: 0.9 }))).toBeNull()
  })

  it('apagado devuelve null', () => {
    expect(buildJevPending(extraction({ jev_pending_domain: 'voucher', jev_answers_pending: 0.9 }))).toBeNull()
  })

  it('sin datos de Jev devuelve null', () => {
    process.env.JEV_ENABLED = 'true'
    process.env.JEV_SHADOW = 'false'
    expect(buildJevPending(extraction({}))).toBeNull()
  })
})
