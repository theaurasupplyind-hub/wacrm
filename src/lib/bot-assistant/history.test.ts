import { describe, it, expect } from 'vitest'
import { buildHistoryText, buildHistoryTextWithCurrent, historyIncludesCurrent } from './history'

describe('historyIncludesCurrent', () => {
  it('true cuando el último turno user es el mensaje actual', () => {
    const turns = [
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: 'qué tal' },
      { role: 'user', content: 'cuánto debo?' },
    ]
    expect(historyIncludesCurrent(turns, 'cuánto debo?')).toBe(true)
  })

  it('false cuando el último turno es del assistant', () => {
    const turns = [{ role: 'assistant', content: 'cuánto debo?' }]
    expect(historyIncludesCurrent(turns, 'cuánto debo?')).toBe(false)
  })
})

describe('buildHistoryTextWithCurrent', () => {
  it('no duplica el mensaje actual si ya está en el historial', () => {
    const turns = [
      { role: 'user', content: 'hola' },
      { role: 'user', content: 'cuánto debo?' },
    ]
    const text = buildHistoryTextWithCurrent(turns, 'cuánto debo?')
    expect(text.match(/cuánto debo\?/g)).toHaveLength(1)
  })

  it('agrega el mensaje actual cuando el historial no lo trae', () => {
    const turns = [{ role: 'user', content: 'hola' }]
    const text = buildHistoryTextWithCurrent(turns, 'y el saldo?')
    expect(text).toBe('user: hola\nuser: y el saldo?')
  })

  it('sin historial devuelve solo el mensaje actual', () => {
    expect(buildHistoryTextWithCurrent([], 'hola')).toBe('user: hola')
  })
})

describe('buildHistoryText', () => {
  it('limita a los últimos 10 turnos', () => {
    const turns = Array.from({ length: 15 }, (_, i) => ({ role: 'user', content: `m${i}` }))
    const lines = buildHistoryText(turns).split('\n')
    expect(lines).toHaveLength(10)
    expect(lines[0]).toBe('user: m5')
  })
})
