import { describe, it, expect, vi, beforeEach } from 'vitest'
import { callOpenRouter } from '@/lib/ai/openrouter'
import { generateAssistantReply } from './responder'

vi.mock('@/lib/ai/openrouter', () => ({
  callOpenRouter: vi.fn(),
}))

const mockedCall = vi.mocked(callOpenRouter)

function ok(text: string) {
  return { text, usage: { prompt_tokens: 1, completion_tokens: 1 } }
}

describe('generateAssistantReply — retry ante respuesta vacía', () => {
  beforeEach(() => {
    mockedCall.mockClear()
  })

  const args = { historyText: 'user: hola', extraction: null, toolResults: null, knowledge: [] }

  it('responde al primer intento si viene texto', async () => {
    mockedCall.mockResolvedValueOnce(ok('Hola'))
    expect(await generateAssistantReply(args)).toBe('Hola')
    expect(mockedCall).toHaveBeenCalledTimes(1)
  })

  it('reintenta una vez si viene vacía y usa el segundo texto', async () => {
    mockedCall.mockRejectedValueOnce(new Error('OpenRouter devolvió respuesta vacía.'))
    mockedCall.mockResolvedValueOnce(ok('Hola de nuevo'))
    expect(await generateAssistantReply(args)).toBe('Hola de nuevo')
    expect(mockedCall).toHaveBeenCalledTimes(2)
  })

  it('si las dos vienen vacías, lanza (el caller pone el fallback)', async () => {
    mockedCall.mockRejectedValue(new Error('OpenRouter devolvió respuesta vacía.'))
    await expect(generateAssistantReply(args)).rejects.toThrow('respuesta vacía')
    expect(mockedCall).toHaveBeenCalledTimes(2)
  })

  it('otros errores no reintentan', async () => {
    mockedCall.mockRejectedValueOnce(new Error('OpenRouter error 500'))
    await expect(generateAssistantReply(args)).rejects.toThrow('500')
    expect(mockedCall).toHaveBeenCalledTimes(1)
  })
})
