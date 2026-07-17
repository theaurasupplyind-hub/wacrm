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
