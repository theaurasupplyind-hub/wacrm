import { describe, it, expect } from 'vitest'
import { isConfirmationReply, isCancellationReply, CONFIRMABLE_TOOLS } from './pending-confirm'

describe('pending confirm replies (Fase 4)', () => {
  it('detecta confirmaciones rioplatenses', () => {
    for (const t of ['sí', 'si', 'dale', 'de una', 'joya', 'ok', 'listo', 'confirmo', 'hacelo', 'metele', 'sí, dale', 'dale!']) {
      expect(isConfirmationReply(t), t).toBe(true)
    }
  })

  it('no confunde charla con confirmación', () => {
    for (const t of ['pagué 18 mil de luz', 'hola', 'sí pero cambiá el monto a 20', 'decime cuánto gasté hoy', '']) {
      expect(isConfirmationReply(t), t).toBe(false)
    }
  })

  it('detecta cancelaciones', () => {
    for (const t of ['no', 'mejor no', 'cancelá', 'olvidalo', 'nada', 'no lo hagas']) {
      expect(isCancellationReply(t), t).toBe(true)
    }
    expect(isCancellationReply('dale')).toBe(false)
    expect(isCancellationReply('pagué la luz')).toBe(false)
  })

  it('whitelist de tools confirmables (nunca otra)', () => {
    expect(CONFIRMABLE_TOOLS.has('registrar_gasto')).toBe(true)
    expect(CONFIRMABLE_TOOLS.has('registrar_asistencia')).toBe(true)
    expect(CONFIRMABLE_TOOLS.has('eliminar_gasto')).toBe(false)
    expect(CONFIRMABLE_TOOLS.has('consultar_facturas')).toBe(false)
  })
})
