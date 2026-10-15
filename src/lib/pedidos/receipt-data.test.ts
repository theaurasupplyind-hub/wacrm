import { describe, it, expect } from 'vitest'
import { invoiceToReceipt } from './receipt-data'
import type { InvoiceDetail } from '@/lib/facbal/client'

const invoice: InvoiceDetail = {
  id: 42,
  numero_factura: 'F-10001',
  numero_presupuesto: 'P-10001',
  fecha: '11/10/2026',
  cliente_id: 3,
  cliente_nombre: 'Juan',
  cliente_telefono: '5491122334455',
  cliente_domicilio: null,
  items: [{ cantidad: 2, descripcion: 'Bastidor 60 x 40 Sin Tela', precio_unitario: 18000, total: 36000 }],
  total: 36000,
  tipo: 'PRESUPUESTO',
  tipo_entrega: 'Retira',
  estado_kanban: 'PEDIDO',
}

describe('invoiceToReceipt', () => {
  it('mapea los campos de la factura', () => {
    const r = invoiceToReceipt(invoice)
    expect(r.numeroPresupuesto).toBe('P-10001')
    expect(r.clienteNombre).toBe('Juan')
    expect(r.items[0].total).toBe(36000)
    expect(r.total).toBe(36000)
  })

  it('fallbacks de número y cliente', () => {
    const r = invoiceToReceipt({ ...invoice, numero_presupuesto: null, cliente_nombre: '' })
    expect(r.numeroPresupuesto).toBe('F-10001')
    expect(r.clienteNombre).toBe('Consumidor Final')
  })

  it('usa #id si no hay números', () => {
    const r = invoiceToReceipt({ ...invoice, numero_presupuesto: null, numero_factura: null })
    expect(r.numeroPresupuesto).toBe('#42')
  })

  it('mapea el domicilio de entrega', () => {
    const r = invoiceToReceipt({ ...invoice, cliente_domicilio: 'Monte 930' })
    expect(r.clienteDomicilio).toBe('Monte 930')
  })
})
