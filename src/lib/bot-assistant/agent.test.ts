import { describe, expect, it } from 'vitest'
import type { UnifiedExtraction } from '@/lib/bot-llm/types'
import { buildAgentMessages } from './agent'

const extraction = {
  intent: 'pedido',
  confianza: 'alta',
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
  raw: '60x40',
} satisfies UnifiedExtraction

describe('buildAgentMessages', () => {
  it('preserva los roles del historial y no duplica el mensaje ya guardado', () => {
    const messages = buildAgentMessages({
      systemPrompt: 'system prompt',
      history: [
        { role: 'user', content: 'Quiero unas lisas' },
        { role: 'assistant', content: '¿Qué medida necesitás?' },
        { role: 'user', content: '60x40' },
      ],
      text: '60x40',
      extraction,
      conversationContext: 'Pedido pendiente: confirmar medida.',
    })

    expect(messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(messages[1].content).toBe('Quiero unas lisas')
    expect(messages[2].content).toBe('¿Qué medida necesitás?')
    expect(messages[3].content).toContain('Pedido pendiente: confirmar medida.')
    expect(messages[3].content).toContain('PISTA DE EXTRACCIÓN')
    expect(messages[3].content).toContain('MENSAJE ACTUAL:\n60x40')
    expect(messages[3].content?.match(/MENSAJE ACTUAL:\n60x40/g)).toHaveLength(1)
  })

  it('agrega el mensaje entrante si todavía no aparece al final del historial', () => {
    const messages = buildAgentMessages({
      systemPrompt: 'system prompt',
      history: [
        { role: 'user', content: 'Quiero unas lisas' },
        { role: 'assistant', content: '¿Qué medida necesitás?' },
      ],
      text: '60x40',
    })

    expect(messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(messages.at(-1)?.content).toBe('MENSAJE ACTUAL:\n60x40')
  })

  it('usa como máximo 19 mensajes previos más el mensaje actual', () => {
    const history = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `turn-${index}`,
    }))
    history.push({ role: 'user', content: 'mensaje actual' })

    const messages = buildAgentMessages({
      systemPrompt: 'system prompt',
      history,
      text: 'mensaje actual',
    })

    expect(messages).toHaveLength(21)
    expect(messages[1].content).toBe('turn-11')
    expect(messages.at(-1)?.content).toBe('MENSAJE ACTUAL:\nmensaje actual')
  })

  it('inyecta el contexto de reintento antes del estado pendiente', () => {
    const messages = buildAgentMessages({
      systemPrompt: 'system prompt',
      history: [],
      text: 'dale, 5000 de luz',
      conversationContext: 'Gasto pendiente: monto.',
      retryContext: 'TURNO ANTERIOR FALLIDO: "gasté en luz".',
    })

    const current = messages.at(-1)?.content ?? ''
    expect(current.indexOf('TURNO ANTERIOR FALLIDO')).toBeLessThan(
      current.indexOf('ESTADO PENDIENTE DE LA CONVERSACIÓN'),
    )
    expect(current).toContain('MENSAJE ACTUAL:\ndale, 5000 de luz')
  })
})
