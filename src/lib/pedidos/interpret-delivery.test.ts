import { describe, it, expect, vi, beforeEach } from 'vitest'
import { callOpenRouter } from '@/lib/ai/openrouter'
import { interpretDeliveryReply } from './interpret-delivery'

vi.mock('@/lib/ai/openrouter', () => ({
  callOpenRouter: vi.fn(),
}))

const mockedCall = vi.mocked(callOpenRouter)
const ADDRS = [
  { address: 'Taller Centro', is_default: true },
  { address: 'Depósito Sur', is_default: false },
]

function mockPayload(payload: unknown) {
  mockedCall.mockResolvedValueOnce({
    text: typeof payload === 'string' ? payload : JSON.stringify(payload),
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  })
}

describe('interpretDeliveryReply (Caso 3)', () => {
  beforeEach(() => {
    mockedCall.mockClear()
  })

  it('parsea todo junto (envío + fecha + domicilio conocido + descuento)', async () => {
    mockPayload({
      tipo_entrega: 'Envio',
      fecha: 'el viernes',
      descuento: { mode: 'percent', value: 10 },
      domicilio: 'Depósito Sur',
    })
    const r = await interpretDeliveryReply('envío, para el viernes, al depósito sur, con 10%', ADDRS)
    expect(r).toEqual({
      tipoEntrega: 'Envio',
      fechaRaw: 'el viernes',
      descuento: { mode: 'percent', value: 10 },
      domicilio: 'Depósito Sur',
    })
  })

  it('acepta domicilio nuevo en texto libre y "no" en fecha/descuento', async () => {
    mockPayload({ tipo_entrega: 'Retira', fecha: 'no', descuento: 'no', domicilio: null })
    const r = await interpretDeliveryReply('retira, sin fecha y sin descuento', [])
    expect(r.tipoEntrega).toBe('Retira')
    expect(r.fechaRaw).toBe('no')
    expect(r.descuento).toBe('no')
  })

  it('parcial: lo no dicho queda null (lo pide advance)', async () => {
    mockPayload({ tipo_entrega: 'Envio', fecha: null, descuento: null, domicilio: null })
    const r = await interpretDeliveryReply('envío', ADDRS)
    expect(r).toEqual({ tipoEntrega: 'Envio' })
  })

  it('valores inválidos se descartan', async () => {
    mockPayload({ tipo_entrega: 'Cohete', fecha: '', descuento: { mode: 'x', value: -5 }, domicilio: '  ' })
    expect(await interpretDeliveryReply('bla', [])).toEqual({})
  })

  it('fallo del LLM o JSON inválido → {} (se pregunta por separado)', async () => {
    mockedCall.mockRejectedValueOnce(new Error('timeout'))
    expect(await interpretDeliveryReply('envío mañana', ADDRS)).toEqual({})
    mockedCall.mockResolvedValueOnce({ text: 'no-json', usage: { prompt_tokens: 1, completion_tokens: 1 } })
    expect(await interpretDeliveryReply('envío mañana', ADDRS)).toEqual({})
  })

  it('mensaje vacío no llama al LLM', async () => {
    expect(await interpretDeliveryReply('   ', ADDRS)).toEqual({})
    expect(mockedCall).not.toHaveBeenCalled()
  })
})
