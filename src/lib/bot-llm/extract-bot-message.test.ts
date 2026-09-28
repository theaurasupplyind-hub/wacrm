import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { callOpenRouter } from '@/lib/ai/openrouter'
import { callJev } from '@/lib/ai/jev'
import { extractBotMessage } from './extract-bot-message'

vi.mock('@/lib/ai/openrouter', () => ({
  callOpenRouter: vi.fn(),
}))

vi.mock('@/lib/ai/jev', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/jev')>()
  return { ...actual, callJev: vi.fn() }
})

const mockedCall = vi.mocked(callOpenRouter)
const mockedJev = vi.mocked(callJev)

function mockJson(payload: unknown) {
  mockedCall.mockResolvedValueOnce({
    text: typeof payload === 'string' ? payload : JSON.stringify(payload),
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  })
}

describe('extractBotMessage — LLM responde JSON válido', () => {
  beforeEach(() => {
    mockedCall.mockClear()
  })

  it('extrae gasto y normaliza el monto "18 mil" → 18000', async () => {
    mockJson({
      intent: 'gasto', confianza: 'alta', monto: '18 mil', categoria: 'luz',
      proveedor: null, empleado_gasto: null, metodo_pago: null, fecha: null,
      faltan_campos: [], dudoso: false, razon_duda: null,
    })
    const r = await extractBotMessage('pagué 18 mil de luz')
    expect(r.intent).toBe('gasto')
    expect(r.confianza).toBe('alta')
    expect(r.monto).toBe(18000)
    expect(r.categoria).toBe('luz')
  })

  it('extrae tipo de compra y saldo pendiente', async () => {
    mockJson({
      intent: 'gasto', confianza: 'alta', monto: 56089, categoria: null,
      tipo_gasto: 'compra', saldo_pendiente: 52089, proveedor: 'Textil Muñoz',
      faltan_campos: [], dudoso: false, razon_duda: null,
    })
    const r = await extractBotMessage('compramos tela a Textil Muñoz valor de 56089')
    expect(r.tipo_gasto).toBe('compra')
    expect(r.saldo_pendiente).toBe(52089)
    expect(r.proveedor).toBe('Textil Muñoz')
  })

  it('normaliza "18k" → 18000 y "$18.000,00" → 18000', async () => {
    mockJson({ intent: 'gasto', confianza: 'alta', monto: '18k' })
    expect((await extractBotMessage('gasté 18k en insumos')).monto).toBe(18000)

    mockJson({ intent: 'gasto', confianza: 'alta', monto: '$18.000,00' })
    expect((await extractBotMessage('pagué $18.000,00 de luz')).monto).toBe(18000)

    mockJson({ intent: 'gasto', confianza: 'alta', monto: '18,000.00' })
    expect((await extractBotMessage('transferí 18,000.00 por insumos')).monto).toBe(18000)
  })

  it('normaliza la hora "8:30" → "08:30"', async () => {
    mockJson({
      intent: 'asistencia_llegada', confianza: 'alta', empleado: 'juan', hora: '8:30',
      faltan_campos: [], dudoso: false,
    })
    const r = await extractBotMessage('llegó juan a las 8:30')
    expect(r.intent).toBe('asistencia_llegada')
    expect(r.empleado).toBe('juan')
    expect(r.hora).toBe('08:30')
  })

  it('normaliza horas compactas y sueltas ("830" → 08:30, "17" → 17:00)', async () => {
    mockJson({ intent: 'asistencia_llegada', confianza: 'alta', hora: '830' })
    expect((await extractBotMessage('830')).hora).toBe('08:30')

    mockJson({ intent: 'asistencia_salida', confianza: 'alta', hora: '17' })
    expect((await extractBotMessage('17')).hora).toBe('17:00')
  })

  it('incluye el contexto en el mensaje al LLM', async () => {
    mockJson({ intent: 'asistencia_llegada', confianza: 'alta', empleado: 'juan', hora: '09:30' })
    await extractBotMessage('9:30', 'Asistencia pendiente: se espera la hora de la llegada de juan.')
    expect(mockedCall).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: expect.stringContaining('CONTEXTO'),
        jsonMode: true,
        temperature: 0.1,
        maxTokens: 1100,
      }),
    )
  })
})

describe('extractBotMessage — fallback ante fallos', () => {
  beforeEach(() => {
    mockedCall.mockClear()
  })

  it('JSON inválido → fallback regex (gasto con confianza baja)', async () => {
    mockJson('esto no es json')
    const r = await extractBotMessage('pagué 18 mil de luz')
    expect(r.intent).toBe('gasto')
    expect(r.confianza).toBe('baja')
    expect(r.monto).toBe(18000)
  })

  it('el LLM falla (throw) → fallback regex', async () => {
    mockedCall.mockRejectedValueOnce(new Error('timeout'))
    const r = await extractBotMessage('llegó juan a las 8:30')
    expect(r.intent).toBe('asistencia_llegada')
    expect(r.empleado).toBe('juan')
    expect(r.hora).toBe('08:30')
  })

  it('intent fuera de rango → fallback regex', async () => {
    mockJson({ intent: 'marciano', confianza: 'alta' })
    const r = await extractBotMessage('pagué 18 mil de luz')
    expect(r.intent).toBe('gasto')
    expect(r.confianza).toBe('baja')
  })

  it('texto vacío → otro sin llamar al LLM', async () => {
    const r = await extractBotMessage('   ')
    expect(r.intent).toBe('otro')
    expect(mockedCall).not.toHaveBeenCalled()
  })
})

describe('extractBotMessage — metadatos de debug', () => {
  beforeEach(() => {
    mockedCall.mockClear()
  })

  it('guarda la respuesta cruda y el JSON sin sanitizar en el éxito', async () => {
    const payload = {
      intent: 'gasto', confianza: 'alta', monto: '18 mil', categoria: 'luz',
      faltan_campos: [], dudoso: false, razon_duda: null,
    }
    mockJson(payload)
    const r = await extractBotMessage('pagué 18 mil de luz')
    expect(r.fallback_reason).toBeUndefined()
    expect(r.llm_raw).toBe(JSON.stringify(payload))
    expect(r.llm_raw_json).toEqual(payload)
    expect(r.llm_usage).toEqual({ prompt_tokens: 1, completion_tokens: 1 })
  })

  it('no_json → fallback con llm_raw y motivo', async () => {
    mockedCall.mockResolvedValueOnce({
      text: 'no sé qué responder',
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    })
    const r = await extractBotMessage('pagué 18 mil de luz')
    expect(r.fallback_reason).toBe('no_json')
    expect(r.llm_raw).toBe('no sé qué responder')
  })

  it('JSON inválido → fallback con llm_raw, motivo y error', async () => {
    mockJson('{ "intent": }')
    const r = await extractBotMessage('pagué 18 mil de luz')
    expect(r.fallback_reason).toBe('invalid_json')
    expect(r.llm_raw).toBe('{ "intent": }')
    expect(r.llm_error).toBe('{ "intent": }')
  })

  it('llm_call_failed → fallback con motivo y error', async () => {
    mockedCall.mockRejectedValueOnce(new Error('timeout'))
    const r = await extractBotMessage('llegó juan a las 8:30')
    expect(r.fallback_reason).toBe('llm_call_failed')
    expect(r.llm_error).toBe('timeout')
    expect(r.llm_raw).toBeUndefined()
  })

  it('schema fuera de rango → fallback con JSON crudo y motivo', async () => {
    mockJson({ intent: 'marciano', confianza: 'alta' })
    const r = await extractBotMessage('pagué 18 mil de luz')
    expect(r.fallback_reason).toBe('schema_out_of_range')
    expect(r.llm_raw_json).toEqual({ intent: 'marciano', confianza: 'alta' })
  })
})

describe('extractBotMessage — Jev (System One)', () => {
  const ENV_KEYS = ['JEV_ENABLED', 'JEV_SHADOW'] as const
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    mockedCall.mockClear()
    mockedJev.mockReset()
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

  function mockJev(choice: string, confidence: number) {
    mockedJev.mockResolvedValueOnce({
      answers: {
        intent: { type: 'choice', choice, probabilities: { [choice]: confidence }, confidence },
        pending_domain: { type: 'choice', choice: 'none', probabilities: {}, confidence: 0.5 },
        answers_pending: { type: 'noul', noul: 0.1 },
        supersedes: { type: 'noul', noul: 0.1 },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  }

  it('activo con confianza alta: el intent de Jev gana y conserva campos del LLM', async () => {
    process.env.JEV_ENABLED = 'true'
    process.env.JEV_SHADOW = 'false'
    mockJson({
      intent: 'gasto', confianza: 'alta', monto: '18 mil', categoria: 'luz',
      faltan_campos: [], dudoso: false, razon_duda: null,
    })
    mockJev('pedido', 0.9)
    const r = await extractBotMessage('pagué 18 mil de luz')
    expect(r.intent).toBe('pedido')
    expect(r.jev_used).toBe(true)
    expect(r.monto).toBe(18000)
    expect(r.jev_intent).toBe('pedido')
  })

  it('activo con confianza baja: conserva el intent del LLM', async () => {
    process.env.JEV_ENABLED = 'true'
    process.env.JEV_SHADOW = 'false'
    mockJson({
      intent: 'gasto', confianza: 'alta', monto: '18 mil', categoria: 'luz',
      faltan_campos: [], dudoso: false, razon_duda: null,
    })
    mockJev('pedido', 0.4)
    const r = await extractBotMessage('pagué 18 mil de luz')
    expect(r.intent).toBe('gasto')
    expect(r.jev_used).toBe(false)
    expect(r.jev_intent).toBe('pedido')
  })

  it('shadow: Jev no decide, solo aporta debug', async () => {
    process.env.JEV_ENABLED = 'true'
    process.env.JEV_SHADOW = 'true'
    mockJson({
      intent: 'gasto', confianza: 'alta', monto: '18 mil', categoria: 'luz',
      faltan_campos: [], dudoso: false, razon_duda: null,
    })
    mockJev('pedido', 0.99)
    const r = await extractBotMessage('pagué 18 mil de luz')
    expect(r.intent).toBe('gasto')
    expect(r.jev_used).toBe(false)
    expect(r.jev_intent).toBe('pedido')
  })

  it('Jev falla: el pipeline del LLM sigue intacto', async () => {
    process.env.JEV_ENABLED = 'true'
    process.env.JEV_SHADOW = 'false'
    mockJson({
      intent: 'gasto', confianza: 'alta', monto: '18 mil', categoria: 'luz',
      faltan_campos: [], dudoso: false, razon_duda: null,
    })
    mockedJev.mockRejectedValueOnce(new Error('jev down'))
    const r = await extractBotMessage('pagué 18 mil de luz')
    expect(r.intent).toBe('gasto')
    expect(r.jev_error).toBe('call_failed')
  })

  it('apagado: no llama a Jev', async () => {
    mockJson({
      intent: 'gasto', confianza: 'alta', monto: '18 mil', categoria: 'luz',
      faltan_campos: [], dudoso: false, razon_duda: null,
    })
    const r = await extractBotMessage('pagué 18 mil de luz')
    expect(r.intent).toBe('gasto')
    expect(r.jev_intent).toBeUndefined()
    expect(mockedJev).not.toHaveBeenCalled()
  })
})
