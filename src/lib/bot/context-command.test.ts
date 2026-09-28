import { describe, it, expect } from 'vitest'
import { classifyContextCommand } from './context-command'

describe('classifyContextCommand', () => {
  it('detecta reset global', () => {
    expect(classifyContextCommand('reiniciar')).toBe('reset_all')
    expect(classifyContextCommand('empezar de nuevo')).toBe('reset_all')
    expect(classifyContextCommand('borrar todo')).toBe('reset_all')
    expect(classifyContextCommand('jesusdanielllavesecreta')).toBe('reset_all')
  })

  it('detecta cancelar del pendiente', () => {
    expect(classifyContextCommand('cancelar')).toBe('cancel_active')
    expect(classifyContextCommand('olvidalo')).toBe('cancel_active')
    expect(classifyContextCommand('mejor no')).toBe('cancel_active')
    expect(classifyContextCommand('después')).toBe('cancel_active')
  })

  it('NO trata "no" ni textos normales como comando', () => {
    expect(classifyContextCommand('no')).toBeNull()
    expect(classifyContextCommand('no, era 5000')).toBeNull()
    expect(classifyContextCommand('cancela la factura de Juan')).toBeNull()
    expect(classifyContextCommand('hola')).toBeNull()
    expect(classifyContextCommand('')).toBeNull()
  })
})
