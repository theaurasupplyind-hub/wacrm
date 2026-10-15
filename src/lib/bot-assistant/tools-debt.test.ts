import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./tool-registry', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./tool-registry')>()
  return {
    ...mod,
    queryProveedores: vi.fn(),
    queryFacturas: vi.fn(),
    queryGastos: vi.fn(),
    queryCategorias: vi.fn(),
    queryEmpleados: vi.fn(),
  }
})

vi.mock('@/lib/facbal/client', () => ({
  getAttendance: vi.fn(),
}))

import { runToolsForQuery } from './tools'
import { queryProveedores, queryFacturas } from './tool-registry'

const mockedProveedores = vi.mocked(queryProveedores)
const mockedFacturas = vi.mocked(queryFacturas)

describe('deuda con proveedor (no confundir con pago ni con deuda de cliente)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedProveedores.mockResolvedValue([])
    mockedFacturas.mockResolvedValue({ cliente_buscado: '', invoices: [], total: 0 })
  })

  it('proveedor conocido → deuda_proveedor con balance, sin deuda_cliente', async () => {
    mockedProveedores.mockResolvedValue([
      { id: 7, name: 'Puerto Maderas', balance: 2963912, stock_qty: 0 },
    ])
    const r = await runToolsForQuery({
      text: '2.963.912 es lo que se debe de madera transferencia',
      intent: 'factura',
      proveedor: 'Puerto Maderas',
    })
    expect(r.toolResults['deuda_proveedor']).toMatchObject({
      providerName: 'Puerto Maderas',
      balance: 2963912,
    })
    expect(r.toolResults).not.toHaveProperty('deuda_cliente')
    expect(mockedFacturas).not.toHaveBeenCalled()
    expect(r.toolLogs.some((l) => l.tool.startsWith('deuda_proveedor'))).toBe(true)
  })

  it('nombre que NO es proveedor → deuda_cliente como antes', async () => {
    mockedProveedores.mockResolvedValue([])
    const r = await runToolsForQuery({
      text: 'cuánto debe Aldo?',
      intent: 'factura',
      proveedor: 'Aldo',
    })
    expect(r.toolResults).not.toHaveProperty('deuda_proveedor')
    expect(r.toolResults).toHaveProperty('deuda_cliente')
    expect(mockedFacturas).toHaveBeenCalled()
  })
})
