import { describe, it, expect } from 'vitest'
import { detectFailureSignal } from './failure-detect'

describe('failure detect (Fase 3)', () => {
  it('detecta error del bot', () => {
    expect(detectFailureSignal('te equivocaste, eran 3')?.reporter).toBe('bot_error')
    expect(detectFailureSignal('no, eso no era')?.reporter).toBe('bot_error')
    expect(detectFailureSignal('cancelá eso')?.reporter).toBe('bot_error')
    expect(detectFailureSignal('borralo')?.reporter).toBe('bot_error')
    expect(detectFailureSignal('deshacé lo último')?.reporter).toBe('bot_error')
  })

  it('distingue error propio del usuario', () => {
    expect(detectFailureSignal('perdón, me equivoqué de monto')?.reporter).toBe('user_error')
    expect(detectFailureSignal('quise decir Edesur')?.reporter).toBe('user_error')
  })

  it('no dispara en mensajes normales ni largos', () => {
    expect(detectFailureSignal('pagué 18 mil de luz')).toBeNull()
    expect(detectFailureSignal('hola')).toBeNull()
    expect(detectFailureSignal('')).toBeNull()
    // "está mal" sin objeto no es feedback (puede ser "está mal la luz")
    expect(detectFailureSignal('está mal la luz del taller')).toBeNull()
    expect(detectFailureSignal('x'.repeat(301))).toBeNull()
  })
})
