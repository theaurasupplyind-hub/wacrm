import { describe, it, expect } from 'vitest'
import { compactToolResults } from './evidence'

describe('compactToolResults', () => {
  it('null/undefined se preservan', () => {
    expect(compactToolResults(null)).toBeNull()
    expect(compactToolResults(undefined)).toBeNull()
  })

  it('recorta listas largas y marca el resto', () => {
    const r = compactToolResults({ expenses: Array.from({ length: 30 }, (_, i) => ({ id: i })) }, 5)
    const arr = r!.expenses as unknown[]
    expect(arr).toHaveLength(6) // 5 items + marcador
    expect(arr[5]).toBe('…(25 más)')
  })

  it('mantiene la forma esperada por el prompt (deuda_cliente.invoices)', () => {
    const r = compactToolResults({
      deuda_cliente: {
        cliente_buscado: 'Aldo',
        total: 39000,
        invoices: [
          { factura: 'F-1', saldo: 39000 },
          { factura: 'F-2', saldo: 0 },
        ],
      },
    })
    const d = r!.deuda_cliente as { invoices: unknown[]; total: number }
    expect(Array.isArray(d.invoices)).toBe(true)
    expect(d.invoices).toHaveLength(2)
    expect(d.total).toBe(39000)
  })

  it('no toca listas cortas', () => {
    const r = compactToolResults({ providers: [1, 2, 3] }, 10)
    expect(r!.providers).toEqual([1, 2, 3])
  })

  it('no trunca catálogos de referencia (categorías/proveedores/empleados)', () => {
    const cats = Array.from({ length: 40 }, (_, i) => ({ id: i, name: `cat-${i}` }))
    const r = compactToolResults({ expense_categories: cats, providers: cats, employees: cats }, 5)
    expect((r!.expense_categories as unknown[]).length).toBe(40)
    expect((r!.providers as unknown[]).length).toBe(40)
    expect((r!.employees as unknown[]).length).toBe(40)
  })

  it('trunca listas de eventos anidadas', () => {
    const r = compactToolResults(
      { deuda_cliente: { invoices: Array.from({ length: 30 }, (_, i) => ({ id: i })) } },
      5,
    )
    const invoices = (r!.deuda_cliente as { invoices: unknown[] }).invoices
    expect(invoices).toHaveLength(6)
  })
})
