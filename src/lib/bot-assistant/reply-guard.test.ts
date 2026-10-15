import { describe, it, expect } from 'vitest'
import { guardAssistantReply, FORBIDDEN_REPLY_FALLBACK } from './reply-guard'

describe('guardAssistantReply (G3)', () => {
  it('bloquea el formato de creación de presupuesto inventado', () => {
    const r = guardAssistantReply(
      'Voy a armar este presupuesto:\n1. Tapiz 39x78 — $22.000\nCliente nuevo: Pachecho\nEntrega: Retira\n¿Confirmás?',
    )
    expect(r.blocked).toBe(true)
    expect(r.text).toBe(FORBIDDEN_REPLY_FALLBACK)
  })

  it('bloquea un número de presupuesto inventado', () => {
    expect(guardAssistantReply('Listo, creé el Presupuesto P-10978 y te lo mando.').blocked).toBe(true)
  })

  it('permite el preview de cotización (tool cotizar_pedido)', () => {
    const t =
      'Cotización estimada:\n1. BASTIDOR 60 x 60 — $21.000\n\nTOTAL: $21.000\n\n¿Querés que la convierta en presupuesto?'
    expect(guardAssistantReply(t)).toEqual({ text: t, blocked: false })
  })

  it('permite el preview de confirmación de una escritura (gasto)', () => {
    const t = 'Revisá antes de guardar (gasto): "gasté 5000 en luz". ¿Confirmás?'
    expect(guardAssistantReply(t).blocked).toBe(false)
  })
})
