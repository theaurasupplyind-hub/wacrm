import { describe, it, expect } from 'vitest'
import { parseDeliveryDate, serializeFechaEntrega, formatFechaEntregaDisplay, isSkipDate } from './dates'

// Fecha "ahora" fija: martes 4/11/2025.
const NOW = new Date(2025, 10, 4) // mes 10 = noviembre

describe('parseDeliveryDate', () => {
  it('interpreta fechas explícitas d/m y d/m/aaaa', () => {
    expect(parseDeliveryDate('15/11', NOW)).toEqual({ desde: '15/11/2025', hasta: '15/11/2025', extras: [] })
    expect(parseDeliveryDate('15/11/2026', NOW)).toEqual({ desde: '15/11/2026', hasta: '15/11/2026', extras: [] })
  })

  it('interpreta rangos', () => {
    expect(parseDeliveryDate('del 10/11 al 15/11', NOW)).toEqual({ desde: '10/11/2025', hasta: '15/11/2025', extras: [] })
  })

  it('interpreta relativos', () => {
    expect(parseDeliveryDate('hoy', NOW)).toEqual({ desde: '4/11/2025', hasta: '4/11/2025', extras: [] })
    expect(parseDeliveryDate('mañana', NOW)).toEqual({ desde: '5/11/2025', hasta: '5/11/2025', extras: [] })
    expect(parseDeliveryDate('en 3 días', NOW)).toEqual({ desde: '7/11/2025', hasta: '7/11/2025', extras: [] })
  })

  it('interpreta días de la semana (el próximo)', () => {
    // 4/11/2025 es martes → "el viernes" = 7/11.
    expect(parseDeliveryDate('el viernes', NOW)).toEqual({ desde: '7/11/2025', hasta: '7/11/2025', extras: [] })
    // "el martes" siendo martes = hoy (mismo día).
    expect(parseDeliveryDate('el martes', NOW)).toEqual({ desde: '4/11/2025', hasta: '4/11/2025', extras: [] })
  })

  it('devuelve null si no entiende', () => {
    expect(parseDeliveryDate('cuando puedas', NOW)).toBeNull()
  })

  it('expande año si la fecha ya pasó', () => {
    expect(parseDeliveryDate('2/1', NOW)).toEqual({ desde: '2/1/2026', hasta: '2/1/2026', extras: [] })
  })
})

describe('serialize/format/isSkip', () => {
  it('serializa al JSON de backend_gal', () => {
    expect(serializeFechaEntrega({ desde: '7/11', hasta: '7/11', extras: [] })).toBe(
      '{"desde":"7/11","hasta":"7/11","extras":[]}',
    )
  })
  it('muestra un texto corto', () => {
    expect(formatFechaEntregaDisplay('{"desde":"7/11","hasta":"7/11","extras":[]}')).toBe('7/11')
    expect(formatFechaEntregaDisplay('{"desde":"7/11","hasta":"10/11","extras":[]}')).toBe('7/11 al 10/11')
    expect(formatFechaEntregaDisplay('')).toBe('')
  })
  it('detecta el skip', () => {
    expect(isSkipDate('no')).toBe(true)
    expect(isSkipDate('después')).toBe(true)
    expect(isSkipDate('15/11')).toBe(false)
  })
})
