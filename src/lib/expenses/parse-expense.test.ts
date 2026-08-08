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

  it('excluye compras de catálogo ("compré 3 bastidores 60x40" → pedido)', () => {
    expect(looksLikeExpense('compré 3 bastidores 60x40')).toBe(false)
    expect(looksLikeExpense('compré un acrílico 50x70')).toBe(false)
    expect(looksLikeExpense('compré 2 telas')).toBe(false)
  })

  it('excluye "pagué el pedido" (confirmación de pedido)', () => {
    expect(looksLikeExpense('pagué el pedido')).toBe(false)
  })

  it('sigue detectando compras de insumos como gasto', () => {
    expect(looksLikeExpense('compré pintura para el taller')).toBe(true)
    expect(looksLikeExpense('compré insumos')).toBe(true)
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

  it('detects debt with "pesos" between keyword and name', () => {
    const result = parseExpense('Le debemos 380.263 pesos a Nico Madison')
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

describe('regex gaps — edge cases', () => {
  it('parses "compré 50000 en insumos"', () => {
    const result = parseExpense('compré 50000 en insumos')
    expect(result.isExpenseIntent).toBe(true)
    expect(result.amount).toBe(50000)
    expect(result.category).toBe('insumos')
  })

  it('parses "pagué 350.75" (decimal con punto)', () => {
    const result = parseExpense('pagué 350.75 en fletes')
    expect(result.isExpenseIntent).toBe(true)
    expect(result.amount).toBe(350.75)
    expect(result.category).toBe('fletes')
  })

  it('parses debt with multi-word provider: "debemos 180000 a Puerto Maderas"', () => {
    const result = parseExpense('debemos 180000 a Puerto Maderas')
    expect(result.isExpenseIntent).toBe(true)
    expect(result.amount).toBe(180000)
    expect(result.provider).toBe('Puerto Maderas')
  })

  it('parses "gaste 8000 en flete" (gaste sin acento)', () => {
    const result = parseExpense('gaste 8000 en flete')
    expect(result.isExpenseIntent).toBe(true)
    expect(result.amount).toBe(8000)
    expect(result.category).toBe('flete')
  })

  it('parses "puse 20000 de nafta a la fiorino"', () => {
    const result = parseExpense('puse 20000 de nafta a la fiorino')
    expect(result.isExpenseIntent).toBe(true)
    expect(result.amount).toBe(20000)
    expect(result.category).toBe('nafta')
  })

  it('parses "deposite 150000 en el banco para insumos"', () => {
    const result = parseExpense('deposite 150000 en insumos')
    expect(result.isExpenseIntent).toBe(true)
    expect(result.amount).toBe(150000)
    expect(result.category).toBe('insumos')
  })

  it('does not extract tiny numbers as amount (días, cantidades chicas)', () => {
    const result = parseExpense('el lunes 16 pague 85000 de alquiler')
    expect(result.amount).toBe(85000)
    expect(result.date).toBeTruthy()
  })

  it('extracts provider with "pagar a" pattern', () => {
    const result = parseExpense('vamos a pagar a Distribuidora Sur 240000')
    expect(result.isExpenseIntent).toBe(true)
    expect(result.amount).toBe(240000)
    expect(result.provider).toBe('Distribuidora Sur')
  })

  it('parses "transferí 32000 por internet"', () => {
    const result = parseExpense('transferí 32000 por internet')
    expect(result.isExpenseIntent).toBe(true)
    expect(result.amount).toBe(32000)
    expect(result.category).toBe('internet')
  })
})

describe('real-world message with saldo', () => {
  it('parses payment and extracts saldo from same message', () => {
    const msg = 'Hoy le pagamos a la madera $965.167,69 por transferencia y 450.000 en efectivo. El saldo en transferencia es 4.000.000 y el saldo en efectivo es 1.261.792,27'
    const result = parseExpense(msg)
    expect(result.isExpenseIntent).toBe(true)
    expect(result.amount).toBe(1415167.69)
    expect(result.provider).toBe('madera')
    expect(result.payments).toHaveLength(2)
    expect(result.payments![0].amount).toBe(965167.69)
    expect(result.payments![1].amount).toBe(450000)
    expect(result.saldo).toHaveLength(2)
    expect(result.saldo![0].amount).toBe(4000000)
    expect(result.saldo![0].payment_method).toBe('transferencia')
    expect(result.saldo![1].amount).toBe(1261792.27)
    expect(result.saldo![1].payment_method).toBe('efectivo')
  })
})

describe('monto robusto — sufijos y formatos', () => {
  it('parsea "18 mil" → 18000', () => {
    const result = parseExpense('pagué 18 mil de luz')
    expect(result.amount).toBe(18000)
    expect(result.amountAmbiguous).toBe(false)
  })

  it('parsea "18k" → 18000', () => {
    const result = parseExpense('gasté 18k en insumos')
    expect(result.amount).toBe(18000)
    expect(result.amountAmbiguous).toBe(false)
  })

  it('parsea "18 m" → 18000', () => {
    const result = parseExpense('costo 18 m')
    expect(result.amount).toBe(18000)
    expect(result.amountAmbiguous).toBe(false)
  })

  it('parsea formato AR "$18.000,00" → 18000', () => {
    const result = parseExpense('pagué $18.000,00 de luz')
    expect(result.amount).toBe(18000)
    expect(result.amountAmbiguous).toBe(false)
  })

  it('parsea formato US "18,000.00" → 18000', () => {
    const result = parseExpense('transferí 18,000.00 por insumos')
    expect(result.amount).toBe(18000)
    expect(result.amountAmbiguous).toBe(false)
  })

  it('ancla el monto a la palabra de dinero sin tomar días', () => {
    const result = parseExpense('pagué el 16 de agosto 85000 de alquiler')
    expect(result.amount).toBe(85000)
    expect(result.amountAmbiguous).toBe(false)
  })

  it('excluye cantidades chicas de la descripción', () => {
    const result = parseExpense('compré 2 sillas y 1 mesa por 25000')
    expect(result.amount).toBe(25000)
    expect(result.amountAmbiguous).toBe(false)
  })

  it('no corta decimales con punto (350.75)', () => {
    const result = parseExpense('pagué 350.75 en fletes')
    expect(result.amount).toBe(350.75)
    expect(result.amountAmbiguous).toBe(false)
  })

  it('marca amountAmbiguous cuando el monto no está anclado a una keyword', () => {
    const result = parseExpense('el alquiler 85000 pagué')
    expect(result.amount).toBe(85000)
    expect(result.amountAmbiguous).toBe(true)
  })

  it('marca ambiguous cuando hay dos montos candidatos en la misma oración', () => {
    const result = parseExpense('pagué 5000 en efectivo y 3000 pendientes')
    expect(result.amount).toBe(5000)
    expect(result.amountAmbiguous).toBe(true)
  })
})
