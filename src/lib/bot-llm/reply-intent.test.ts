import { describe, it, expect } from 'vitest'
import { classifyReply, classifyYesNo, isDismissCommand } from './reply-intent'

describe('reply-intent (fix #4: módulo único)', () => {
  it('confirma con palabra + verbo que repite la oferta (incidente 2)', () => {
    for (const t of [
      'si conviertela en presupuesto',
      'sí, convertilo',
      'dale hacelo',
      'si, armalo',
      'ok, crealo',
      'de una',
      'sí',
      'si confirmo',
      'ok listo, confirmo',
      'confirmo el pedido',
      'de acuerdo',
    ]) {
      expect(classifyReply(t), t).toBe('confirm')
    }
  })

  it('cancela igual que antes', () => {
    for (const t of [
      'no',
      'cancelar',
      'cancela',
      'no cancela',
      'dejalo',
      'anular',
      'no, nada',
      'no gracias',
      'mejor no',
      'no lo creas, era una prueba',
      'no quiero un presupuesto',
    ]) {
      expect(classifyReply(t), t).toBe('cancel')
    }
  })

  it('contenido nuevo sigue a corrección (other)', () => {
    for (const t of [
      'el 2 sin tela',
      'si, el 2 sin tela',
      'no, sacá el 3',
      'No, mejor cambialo a 20x30',
      'sí pero cambiá el monto a 20',
      'hola',
      'pagué 18 mil de luz',
    ]) {
      expect(classifyReply(t), t).toBe('other')
    }
  })

  it('comando global de descarte (superset para context-command)', () => {
    for (const t of ['cancelar', 'cancela', 'después', 'todavía no', 'saltar', 'ninguno', 'nada', 'mejor no']) {
      expect(isDismissCommand(t), t).toBe(true)
    }
    for (const t of ['no cancela', 'hola', 'cancela la factura de Aldo', 'no', '']) {
      expect(isDismissCommand(t), t).toBe(false)
    }
  })
})

describe('classifyYesNo (cuarto detector sí/no, unificado)', () => {
  it('confirma un candidato ("¿es ese?")', () => {
    for (const t of ['si', 'sí', 'sisi', 'claro', 'ese', 'esa', 'es ese', 'correcto', 'exacto', 'afirmativo']) {
      expect(classifyYesNo(t), t).toBe('yes')
    }
  })

  it('niega el candidato: pide otro, NO cancela', () => {
    for (const t of ['no', 'nop', 'nope', 'otro', 'otra', 'ninguno', 'ninguna', 'nuevo', 'nueva']) {
      expect(classifyYesNo(t), t).toBe('no')
    }
  })

  it('sin señal o contradictorio → null', () => {
    for (const t of ['', 'hola', 'si pero no', 'el de la esquina']) {
      expect(classifyYesNo(t), t).toBeNull()
    }
  })
})
