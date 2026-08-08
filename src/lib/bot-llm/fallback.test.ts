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

  it('detecta 3 gastos separados por coma', () => {
    const r = fallbackExtract('Gastos varios dia lunes: $40 mil nafta, $34.500 bulonera, 38.000 empanadas')
    expect(r.intent).toBe('multi_expense')
    expect(r.multipleExpenses?.length).toBe(3)
    expect(r.multipleExpenses?.[0].amount).toBe(40000)
    expect(r.multipleExpenses?.[0].category).toBe('nafta')
    expect(r.multipleExpenses?.[1].amount).toBe(34500)
    expect(r.multipleExpenses?.[1].category).toBe('bulonera')
    expect(r.multipleExpenses?.[2].amount).toBe(38000)
    expect(r.multipleExpenses?.[2].category).toBe('empanadas')
  })

  it('detecta 2 gastos separados por "y"', () => {
    const r = fallbackExtract('gaste 5000 en luz y 2000 en gas')
    expect(r.intent).toBe('multi_expense')
    expect(r.multipleExpenses?.length).toBe(2)
    expect(r.multipleExpenses?.[0].amount).toBe(5000)
    expect(r.multipleExpenses?.[0].category).toBe('luz')
    expect(r.multipleExpenses?.[1].amount).toBe(2000)
    expect(r.multipleExpenses?.[1].category).toBe('gas')
  })

  it('split de pago NO es multi-expense → gasto simple', () => {
    const r = fallbackExtract('pagué 5.000 por transferencia y 2.000 en efectivo')
    expect(r.intent).toBe('gasto')
    expect(r.monto).toBe(7000)
  })

  it('saldo NO es multi-expense', () => {
    const r = fallbackExtract('saldo en transferencia es 4.000.000 y saldo en efectivo es 1.261.792,27')
    expect(r.intent).not.toBe('multi_expense')
  })

  it('un solo monto NO es multi-expense → gasto simple', () => {
    const r = fallbackExtract('pagué 18 mil de luz')
    expect(r.intent).toBe('gasto')
    expect(r.multipleExpenses).toBeUndefined()
  })
})
