import { describe, it, expect } from 'vitest'
import { buildExpensePreview } from './confirm-expense'
import type { ExpenseFuzzyMatch } from './types'

const base = {
  amount: 25000,
  description: 'Gasto',
  category: null,
  provider: 'Jesus',
  employee: null,
}

const noEntity: ExpenseFuzzyMatch = {
  categoryId: 1,
  categoryName: 'Sueldos y salarios',
  categoryWasCreated: false,
  providerId: null,
  providerName: 'Jesus',
  employeeId: null,
  employeeName: null,
}

describe('buildExpensePreview', () => {
  it('muestra la entidad resuelta como empleado, no el texto crudo', () => {
    const match: ExpenseFuzzyMatch = {
      ...noEntity,
      categoryName: 'Sueldos y salarios',
      employeeId: 17,
      employeeName: 'Jesus',
    }
    const preview = buildExpensePreview(base, match)
    expect(preview).toContain('👷 Empleado: Jesus')
    expect(preview).not.toContain('🏭 Proveedor: Jesus')
    expect(preview).toContain('Sueldos y salarios')
  })

  it('muestra el proveedor solo cuando quedó resuelto (con id)', () => {
    const match: ExpenseFuzzyMatch = {
      ...noEntity,
      categoryName: 'Pago a proveedor',
      providerId: 5,
      providerName: 'Textil Muñoz',
    }
    const preview = buildExpensePreview(base, match)
    expect(preview).toContain('🏭 Proveedor: Textil Muñoz')
    expect(preview).not.toContain('sin vínculo')
  })

  it('advierte cuando la entidad queda sin resolver', () => {
    const preview = buildExpensePreview(base, noEntity)
    expect(preview).toContain('sin vínculo')
    expect(preview).not.toContain('🏭 Proveedor: Jesus')
  })
})
