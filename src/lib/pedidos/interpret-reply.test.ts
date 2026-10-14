import { describe, it, expect, vi, beforeEach } from 'vitest'
import { callOpenRouter } from '@/lib/ai/openrouter'
import { interpretOrderReply } from './interpret-reply'

vi.mock('@/lib/ai/openrouter', () => ({
  callOpenRouter: vi.fn(),
}))

const mockedCall = vi.mocked(callOpenRouter)
const PENDING = { waitingFor: 'aprobación de cotización $479.000' }

function mockDecision(decision: string) {
  mockedCall.mockResolvedValueOnce({
    text: JSON.stringify({ decision }),
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  })
}

describe('interpretOrderReply (anti-keywords)', () => {
  beforeEach(() => {
    mockedCall.mockClear()
  })

  it('fast path: lo obvio no llama al LLM', async () => {
    expect(await interpretOrderReply('sí', PENDING)).toEqual({ decision: 'confirm' })
    expect(await interpretOrderReply('cancelar', PENDING)).toEqual({ decision: 'cancel' })
    expect(mockedCall).not.toHaveBeenCalled()
  })

  it('LLM entiende aprobación con rodeos', async () => {
    mockDecision('confirm')
    expect(await interpretOrderReply('sip dale, mandalo ya', PENDING)).toEqual({ decision: 'confirm' })
    expect(mockedCall).toHaveBeenCalledTimes(1)
  })

  it('LLM entiende cancelación indirecta', async () => {
    mockDecision('cancel')
    expect(await interpretOrderReply('al final lo dejamos', PENDING)).toEqual({ decision: 'cancel' })
  })

  it('LLM dice other ante corrección', async () => {
    mockDecision('other')
    expect(await interpretOrderReply('mejor de 60x40', PENDING)).toEqual({ decision: 'other' })
  })

  it('fallo del LLM o JSON inválido → other (comportamiento actual)', async () => {
    mockedCall.mockRejectedValueOnce(new Error('timeout'))
    expect(await interpretOrderReply('bla bla', PENDING)).toEqual({ decision: 'other' })
    mockedCall.mockResolvedValueOnce({ text: 'no-json', usage: { prompt_tokens: 1, completion_tokens: 1 } })
    expect(await interpretOrderReply('bla bla', PENDING)).toEqual({ decision: 'other' })
  })
})
