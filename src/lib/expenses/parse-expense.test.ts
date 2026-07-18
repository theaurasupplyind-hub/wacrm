import { describe, it, expect } from 'vitest'
import { parseExpense, looksLikeExpense } from './parse-expense'

describe('parseExpense', () => {
  it('detects expense intent for "pagué"', () => {
    const result = parseExpense('pagué 18000 de luz')
    expect(result.isExpenseIntent).toBe(true)
    expect(result.amount).toBe(18000)
    expect(result.category).toBe('luz')
    expect(result.description).toMatch(/luz/i)
  })

  it('detects expense intent for "gasté"', () => {
    const result = parseExpense('gasté 4500 en capacitación')
    expect(result.isExpenseIntent).toBe(true)
    expect(result.amount).toBe(4500)
    expect(result.category).toBe('capacitación')
  })

  it('detects provider payment', () => {
    const result = parseExpense('pagué 56000 a proveedor Rosario')
    expect(result.isExpenseIntent).toBe(true)
    expect(result.amount).toBe(56000)
    expect(result.provider).toBe('Rosario')
  })

  it('detects employee payment', () => {
    const result = parseExpense('pago de sueldo a Juan 100000')
    expect(result.isExpenseIntent).toBe(true)
    expect(result.amount).toBe(100000)
    expect(result.employee).toBe('Juan')
  })

  it('parses amount with thousands separator', () => {
    const result = parseExpense('pagué 18.000 de luz')
    expect(result.amount).toBe(18000)
  })

  it('parses amount with decimal', () => {
    const result = parseExpense('gasté 1500,50 en almuerzo')
    expect(result.amount).toBe(1500.5)
  })

  it('does not flag non-expense text', () => {
    const result = parseExpense('hola, quería hacer un pedido')
    expect(result.isExpenseIntent).toBe(false)
  })
})

describe('looksLikeExpense', () => {
  it('returns true for expense keywords', () => {
    expect(looksLikeExpense('pagué la luz')).toBe(true)
    expect(looksLikeExpense('gasto de alquiler')).toBe(true)
  })

  it('returns false for order keywords', () => {
    expect(looksLikeExpense('quiero un bastidor 40x50')).toBe(false)
  })
})

describe('split payments', () => {
  it('detects split payment: $X por transferencia y $Y en efectivo', () => {
    const result = parseExpense('pagamos a la madera 965.167,69 por transferencia y 450.000 en efectivo')
    expect(result.isExpenseIntent).toBe(true)
    expect(result.amount).toBe(1415167.69)
    expect(result.provider).toBe('madera')
    expect(result.payments).toHaveLength(2)
    expect(result.payments![0].amount).toBe(965167.69)
    expect(result.payments![0].payment_method).toBe('transferencia')
    expect(result.payments![1].amount).toBe(450000)
    expect(result.payments![1].payment_method).toBe('efectivo')
  })

  it('detects split payment: $X en efectivo y $Y por transferencia', () => {
    const result = parseExpense('pague 5000 en efectivo y 10000 por transferencia')
    expect(result.isExpenseIntent).toBe(true)
    expect(result.amount).toBe(15000)
    expect(result.payments).toHaveLength(2)
  })
})

describe('debt detection', () => {
  it('detects "le debemos" as expense intent with provider', () => {
    const result = parseExpense('le debemos 380.263 a Nico Madison')
    expect(result.isExpenseIntent).toBe(true)
    expect(result.amount).toBe(380263)
    expect(result.provider).toBe('Nico Madison')
  })
})

describe('custom date parsing', () => {
  it('parses "el 15/7/26" as date', () => {
    const result = parseExpense('el 15/7/26 pagamos 5000 de luz')
    expect(result.date).toBe('2026-07-15')
  })

  it('parses "ayer" as date', () => {
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const expected = yesterday.toISOString().slice(0, 10)
    const result = parseExpense('ayer pague 3000 de agua')
    expect(result.date).toBe(expected)
  })

  it('parses "hoy" as date', () => {
    const today = new Date().toISOString().slice(0, 10)
    const result = parseExpense('hoy pague 2000 de internet')
    expect(result.date).toBe(today)
  })
})

describe('fuel expense', () => {
  it('detects fuel expense with vehicle in description', () => {
    const result = parseExpense('hoy jueves 16 le puse 101027 a la fiorino en nafta')
    expect(result.isExpenseIntent).toBe(true)
    expect(result.amount).toBe(101027)
    expect(result.category).toBe('nafta')
    expect(result.description!.toLowerCase()).toContain('fiorino')
  })
})

describe('real-world message with saldo', () => {
  it('parses payment correctly ignoring saldo statement', () => {
    const msg = 'Hoy le pagamos a la madera $965.167,69 por transferencia y 450.000 en efectivo. El saldo en transferencia es 4.000.000 y el saldo en efectivo es 1.261.792,27'
    const result = parseExpense(msg)
    expect(result.isExpenseIntent).toBe(true)
    expect(result.amount).toBe(1415167.69)
    expect(result.provider).toBe('madera')
    expect(result.payments).toHaveLength(2)
    expect(result.payments![0].amount).toBe(965167.69)
    expect(result.payments![1].amount).toBe(450000)
  })
})
