import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  createInvoice: vi.fn(),
  nextInvoiceNumber: vi.fn(),
  searchClients: vi.fn(),
  createClient: vi.fn(),
}))

vi.mock('@/lib/facbal/client', () => ({
  createInvoice: mocks.createInvoice,
  nextInvoiceNumber: mocks.nextInvoiceNumber,
  searchClients: mocks.searchClients,
  createClient: mocks.createClient,
}))

import { executePedido } from './execute'
import type { PedidoItem } from './types'

const item: PedidoItem = {
  cantidad: 2,
  categoria: 'BASTIDOR',
  medida: '40 x 60',
  variante: 'Sin Tela',
  precio_unitario: 18000,
  faltante: false,
  descripcion: 'Bastidor 40 x 60 Sin Tela',
  regla_aplicada: null,
}

describe('executePedido', () => {
  beforeEach(() => {
    mocks.nextInvoiceNumber.mockResolvedValue('F-1001')
    mocks.createInvoice.mockImplementation(async (p: Record<string, unknown>) => ({
      id: 55,
      numero_factura: p.numero_factura,
      numero_presupuesto: p.numero_presupuesto,
      fecha: p.fecha,
      cliente_nombre: p.cliente_nombre,
      total: p.total,
      tipo: p.tipo,
    }))
    mocks.searchClients.mockResolvedValue(null)
    mocks.createClient.mockResolvedValue({ id: 10, nombre: 'X' })
  })

  it('usa el cliente resuelto y manda entrega, fecha y descuento (ítem negativo)', async () => {
    const r = await executePedido({
      clienteNombre: 'Juan',
      clienteId: 7,
      clienteTelefono: '5491133344444',
      items: [item],
      tipoEntrega: 'Envio',
      fechaEntrega: '{"desde":"7/11","hasta":"7/11","extras":[]}',
      descuento: { mode: 'percent', value: 10, amount: 3600 },
    })

    expect(r.total).toBe(32400)
    expect(r.numeroPresupuesto).toBe('P-1001')
    // El cliente ya venía resuelto: no se re-busca ni se crea.
    expect(mocks.searchClients).not.toHaveBeenCalled()
    expect(mocks.createClient).not.toHaveBeenCalled()

    const payload = mocks.createInvoice.mock.calls[0][0] as {
      tipo_entrega: string
      fecha_entrega: string
      cliente_id: number | null
      cliente_telefono: string
      total: number
      items: { descripcion: string; total: number; precio_unitario: number }[]
    }
    expect(payload.tipo_entrega).toBe('Envio')
    expect(payload.fecha_entrega).toBe('{"desde":"7/11","hasta":"7/11","extras":[]}')
    expect(payload.cliente_id).toBe(7)
    expect(payload.cliente_telefono).toBe('5491133344444')
    expect(payload.total).toBe(32400)

    const desc = payload.items.find(i => i.descripcion === 'DESCUENTO')
    expect(desc).toMatchObject({ total: -3600, precio_unitario: -3600 })
  })

  it('sin descuento no agrega ítem y usa defaults de entrega', async () => {
    const r = await executePedido({ clienteNombre: 'Juan', clienteId: 7, items: [item] })
    expect(r.total).toBe(36000)
    const payload = mocks.createInvoice.mock.calls[0][0] as {
      tipo_entrega: string
      fecha_entrega: string
      items: { descripcion: string }[]
    }
    expect(payload.tipo_entrega).toBe('Retira')
    expect(payload.fecha_entrega).toBe('')
    expect(payload.items.some(i => i.descripcion === 'DESCUENTO')).toBe(false)
  })

  it('no asocia el teléfono del dueño al cliente nuevo ni al presupuesto', async () => {
    await executePedido({ clienteNombre: 'Fede', items: [item] })

    expect(mocks.searchClients).toHaveBeenCalledWith('Fede')
    expect(mocks.createClient).toHaveBeenCalledWith({ nombre: 'Fede' })
    const payload = mocks.createInvoice.mock.calls[0][0] as Record<string, unknown>
    expect(payload.cliente_telefono).toBeUndefined()
  })

  it('rechaza un número como nombre de cliente antes de crear registros', async () => {
    await expect(
      executePedido({ clienteNombre: '5491125491605', items: [item] }),
    ).rejects.toThrow('El teléfono del remitente no puede usarse como nombre de cliente.')

    expect(mocks.searchClients).not.toHaveBeenCalled()
    expect(mocks.createClient).not.toHaveBeenCalled()
    expect(mocks.createInvoice).not.toHaveBeenCalled()
  })
})
