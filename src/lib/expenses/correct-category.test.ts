import { describe, it, expect } from 'vitest'
import { isCategoryCorrectionCommand } from './command'

describe('isCategoryCorrectionCommand', () => {
  it('detects the command as promised by the bot', () => {
    expect(isCategoryCorrectionCommand('corregir categoría')).toBe(true)
    expect(isCategoryCorrectionCommand('corregir categoria')).toBe(true)
  })

  it('detects variants without accents and "la categoría"', () => {
    expect(isCategoryCorrectionCommand('corregir la categoria')).toBe(true)
    expect(isCategoryCorrectionCommand('Corregir Categoría')).toBe(true)
    expect(isCategoryCorrectionCommand('cambiar categoría')).toBe(true)
    expect(isCategoryCorrectionCommand('cambio la categoria')).toBe(true)
  })

  it('rejects unrelated messages', () => {
    expect(isCategoryCorrectionCommand('pagué 25 mil de luz')).toBe(false)
    expect(isCategoryCorrectionCommand('corregir monto')).toBe(false)
    expect(isCategoryCorrectionCommand('hola')).toBe(false)
    expect(isCategoryCorrectionCommand('sueldos y salarios')).toBe(false)
    expect(isCategoryCorrectionCommand('')).toBe(false)
  })
})
