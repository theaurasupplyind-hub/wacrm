import { describe, it, expect } from 'vitest'
import { parseAttendance, looksLikeAttendance } from './parse-attendance'

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function lastWeekdayIso(idx: number): string {
  const now = new Date()
  const diff = (now.getDay() - idx + 7) % 7
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function lastMonday(): string {
  return lastWeekdayIso(1)
}

function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function monthDayIso(month: number, day: number, year?: number): string {
  return `${year ?? new Date().getFullYear()}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

describe('parseAttendance — llegada', () => {
  it('detects "llegó juan a las 8:30" (nombre después de keyword)', () => {
    const r = parseAttendance('llegó juan a las 8:30')
    expect(r.isAttendanceIntent).toBe(true)
    expect(r.statusType).toBe('arrival')
    expect(r.employeeName).toBe('juan')
    expect(r.time).toBe('08:30')
    expect(r.date).toBe(today())
  })

  it('detects "juan llegó a las 8:30" (nombre antes de keyword)', () => {
    const r = parseAttendance('juan llegó a las 8:30')
    expect(r.isAttendanceIntent).toBe(true)
    expect(r.statusType).toBe('arrival')
    expect(r.employeeName).toBe('juan')
    expect(r.time).toBe('08:30')
  })

  it('detects "llegó juan" sin hora', () => {
    const r = parseAttendance('llegó juan')
    expect(r.isAttendanceIntent).toBe(true)
    expect(r.employeeName).toBe('juan')
    expect(r.time).toBe('00:00')
  })

  it('detects "maria llegó 9:00"', () => {
    const r = parseAttendance('maria llegó 9:00')
    expect(r.statusType).toBe('arrival')
    expect(r.employeeName).toBe('maria')
    expect(r.time).toBe('09:00')
  })
})

describe('parseAttendance — salida', () => {
  it('detects "me voy a las 17:00" sin nombre', () => {
    const r = parseAttendance('me voy a las 17:00')
    expect(r.isAttendanceIntent).toBe(true)
    expect(r.statusType).toBe('departure')
    expect(r.employeeName).toBeNull()
    expect(r.time).toBe('17:00')
  })

  it('detects "juan se fue a las 17:00" (nombre antes)', () => {
    const r = parseAttendance('juan se fue a las 17:00')
    expect(r.isAttendanceIntent).toBe(true)
    expect(r.statusType).toBe('departure')
    expect(r.employeeName).toBe('juan')
    expect(r.time).toBe('17:00')
  })

  it('detects "se fue juan a las 17" (nombre después)', () => {
    const r = parseAttendance('se fue juan a las 17')
    expect(r.isAttendanceIntent).toBe(true)
    expect(r.statusType).toBe('departure')
    expect(r.employeeName).toBe('juan')
    expect(r.time).toBe('17:00')
  })

  it('detects "salí a las 18:30"', () => {
    const r = parseAttendance('salí a las 18:30')
    expect(r.isAttendanceIntent).toBe(true)
    expect(r.statusType).toBe('departure')
    expect(r.time).toBe('18:30')
    expect(r.employeeName).toBeNull()
  })

  it('detects "terminé a las 20"', () => {
    const r = parseAttendance('terminé a las 20')
    expect(r.statusType).toBe('departure')
    expect(r.time).toBe('20:00')
  })

  it('detects "chau a las 19:45"', () => {
    const r = parseAttendance('chau a las 19:45')
    expect(r.statusType).toBe('departure')
    expect(r.time).toBe('19:45')
  })
})

describe('parseAttendance — estados', () => {
  it('detects "juan está de vacaciones"', () => {
    const r = parseAttendance('juan está de vacaciones')
    expect(r.isAttendanceIntent).toBe(true)
    expect(r.statusType).toBe('vacaciones')
    expect(r.employeeName).toBe('juan')
  })

  it('detects "maria de licencia"', () => {
    const r = parseAttendance('maria de licencia')
    expect(r.statusType).toBe('licencia')
    expect(r.employeeName).toBe('maria')
  })

  it('detects "juan ausente hoy"', () => {
    const r = parseAttendance('juan ausente hoy')
    expect(r.statusType).toBe('ausente')
    expect(r.employeeName).toBe('juan')
  })
})

describe('parseAttendance — fechas', () => {
  it('"jesus llego a las 11am el lunes" → último lunes + 11:00', () => {
    const r = parseAttendance('jesus llego a las 11am el lunes')
    expect(r.isAttendanceIntent).toBe(true)
    expect(r.statusType).toBe('arrival')
    expect(r.employeeName).toBe('jesus')
    expect(r.time).toBe('11:00')
    expect(r.date).toBe(lastMonday())
  })

  it('"juan llego a las 8:30 el lunes" → último lunes', () => {
    const r = parseAttendance('juan llego a las 8:30 el lunes')
    expect(r.employeeName).toBe('juan')
    expect(r.time).toBe('08:30')
    expect(r.date).toBe(lastMonday())
  })

  it('"juan salio a las 3 pm" → 15:00', () => {
    const r = parseAttendance('juan salio a las 3 pm')
    expect(r.statusType).toBe('departure')
    expect(r.time).toBe('15:00')
  })

  it('"juan llego el 09 del 08" → fecha exacta', () => {
    const r = parseAttendance('juan llego el 09 del 08')
    expect(r.employeeName).toBe('juan')
    expect(r.date).toBe(monthDayIso(8, 9))
  })

  it('"juan llego 9 de agosto" → fecha exacta', () => {
    const r = parseAttendance('juan llego 9 de agosto')
    expect(r.employeeName).toBe('juan')
    expect(r.date).toBe(monthDayIso(8, 9))
  })

  it('"juan llego el 9 de Agosto de 2025" → año explícito', () => {
    const r = parseAttendance('juan llego el 9 de Agosto de 2025')
    expect(r.date).toBe('2025-08-09')
  })

  it('"juan llego 9 del 08 del 25" → año corto 2025', () => {
    const r = parseAttendance('juan llego 9 del 08 del 25')
    expect(r.date).toBe('2025-08-09')
  })

  it('"juan llego 09/08/2026" → fecha con barra', () => {
    const r = parseAttendance('juan llego 09/08/2026')
    expect(r.date).toBe('2026-08-09')
  })

  it('"juan llego ayer" → ayer', () => {
    const r = parseAttendance('juan llego ayer')
    expect(r.date).toBe(daysAgo(1))
  })

  it('fecha exacta gana y corrige el día de semana: "el lunes 09 del 08 llego juan"', () => {
    const r = parseAttendance('el lunes 09 del 08 llego juan')
    expect(r.employeeName).toBe('juan')
    expect(r.date).toBe(monthDayIso(8, 9))
  })

  it('"juan vacaciones el lunes" → último lunes', () => {
    const r = parseAttendance('juan vacaciones el lunes')
    expect(r.statusType).toBe('vacaciones')
    expect(r.employeeName).toBe('juan')
    expect(r.date).toBe(lastMonday())
  })

  it('sin fecha sigue cayendo a hoy: "maria llegó 9:00"', () => {
    const r = parseAttendance('maria llegó 9:00')
    expect(r.time).toBe('09:00')
    expect(r.date).toBe(today())
  })
})

describe('parseAttendance — no intención', () => {
  it('no marca texto sin intención', () => {
    const r = parseAttendance('hola, quería hacer un pedido')
    expect(r.isAttendanceIntent).toBe(false)
  })
})

describe('looksLikeAttendance', () => {
  it('detecta llegada', () => {
    expect(looksLikeAttendance('llegó juan')).toBe(true)
  })

  it('detecta salida', () => {
    expect(looksLikeAttendance('me voy a las 17:00')).toBe(true)
    expect(looksLikeAttendance('juan se fue')).toBe(true)
    expect(looksLikeAttendance('salgo ahora')).toBe(true)
  })

  it('detecta estados', () => {
    expect(looksLikeAttendance('juan de vacaciones')).toBe(true)
  })

  it('no detecta "se fue la luz" como salida', () => {
    expect(looksLikeAttendance('se fue la luz')).toBe(false)
    expect(looksLikeAttendance('se cortó la luz')).toBe(false)
  })

  it('sigue detectando "se fue" con persona', () => {
    expect(looksLikeAttendance('juan se fue')).toBe(true)
    expect(looksLikeAttendance('se fue juan')).toBe(true)
  })

  it('no detecta texto de pedido', () => {
    expect(looksLikeAttendance('quiero un bastidor 40x50')).toBe(false)
    expect(looksLikeAttendance('buen día')).toBe(false)
  })
})
