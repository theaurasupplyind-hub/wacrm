import { describe, it, expect } from 'vitest'
import { detectPastedConversation } from './pasted-conversation'

describe('detectPastedConversation', () => {
  it('detecta bloque ambos lados y extrae solo cliente', () => {
    const text = `[14:32, 2/9/2026] Juan Pérez: hola necesito 2 bastidores 60x40 sin tela
[14:33, 2/9/2026] Vos: Hola Juan, ¿qué medida?
[14:34, 2/9/2026] Juan Pérez: 60x40 sin tela a nombre de Juan Pérez`
    const r = detectPastedConversation(text)
    expect(r).not.toBeNull()
    expect(r!.speaker).toBe('Juan Pérez')
    expect(r!.customerText).toContain('hola necesito 2 bastidores')
    expect(r!.customerText).not.toContain('Hola Juan')
  })

  it('single-line no es paste (evita falsos positivos)', () => {
    const text = `Saludos: quiero info`
    expect(detectPastedConversation(text)).toBeNull()
  })

  it('una sola línea con bracket no es paste (requiere >=2)', () => {
    const text = `[14:32] Juan: hola`
    expect(detectPastedConversation(text)).toBeNull()
  })

  it('all-Vos → null', () => {
    const text = `[14:32] Vos: hola
[14:33] Vos: chau`
    expect(detectPastedConversation(text)).toBeNull()
  })

  it('extrae speaker último cliente', () => {
    const text = `[10:00] Ana: quiero 1 bastidor 40x40
[10:01] Vos: ok
[10:02] Ana: y otro 50x50
[10:03] Carlos: me sumo con uno 60x60`
    const r = detectPastedConversation(text)
    expect(r!.speaker).toBe('Carlos')
    expect(r!.customerText).toBe('quiero 1 bastidor 40x40\ny otro 50x50\nme sumo con uno 60x60')
  })
})
