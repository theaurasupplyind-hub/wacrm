import { describe, it, expect } from 'vitest'
import { fallbackExtract } from './fallback'

describe('fallbackExtract', () => {
  it('detecta gasto con monto y categoría', () => {
    const r = fallbackExtract('pagué 18 mil de luz')
    expect(r.intent).toBe('gasto')
    expect(r.confianza).toBe('baja')
    expect(r.monto).toBe(18000)
    expect(r.categoria).toBe('luz')
  })

  it('detecta llegada', () => {
    const r = fallbackExtract('llegó juan a las 8:30')
    expect(r.intent).toBe('asistencia_llegada')
    expect(r.empleado).toBe('juan')
    expect(r.hora).toBe('08:30')
  })

  it('detecta salida', () => {
    const r = fallbackExtract('juan se fue a las 17:00')
    expect(r.intent).toBe('asistencia_salida')
    expect(r.empleado).toBe('juan')
    expect(r.hora).toBe('17:00')
  })

  it('hora 00:00 (default del parser) se trata como faltante', () => {
    const r = fallbackExtract('llegó juan')
    expect(r.intent).toBe('asistencia_llegada')
    expect(r.hora).toBeNull()
    expect(r.faltan_campos).toContain('hora')
    expect(r.dudoso).toBe(true)
  })

  it('detecta estado vacaciones', () => {
    const r = fallbackExtract('juan está de vacaciones')
    expect(r.intent).toBe('asistencia_estado')
    expect(r.empleado).toBe('juan')
    expect(r.estado).toBe('vacaciones')
  })

  it('"se fue la luz" NO es asistencia → otro', () => {
    const r = fallbackExtract('se fue la luz')
    expect(r.intent).toBe('otro')
  })

  it('"compré 3 bastidores 60x40" NO es gasto → otro', () => {
    const r = fallbackExtract('compré 3 bastidores 60x40')
    expect(r.intent).toBe('otro')
  })

  it('"compré pintura para el taller" SÍ es gasto', () => {
    const r = fallbackExtract('compré pintura para el taller')
    expect(r.intent).toBe('gasto')
  })

  it('"pagué el pedido" NO es gasto → otro', () => {
    const r = fallbackExtract('pagué el pedido')
    expect(r.intent).toBe('otro')
  })

  it('texto normal → otro sin dudoso', () => {
    const r = fallbackExtract('hola, cómo va?')
    expect(r.intent).toBe('otro')
    expect(r.dudoso).toBe(false)
  })
})
