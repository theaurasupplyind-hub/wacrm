import type { InvoiceDetail } from '@/lib/facbal/client'
import type { ReceiptData } from './receipt-image'

/** Mapea la factura de backend_gal a los datos de la tarjeta de WhatsApp. */
export function invoiceToReceipt(invoice: InvoiceDetail, faltantes: string[] = []): ReceiptData {
  const tipoEntrega = invoice.tipo_entrega || 'Retira'
  return {
    numeroPresupuesto: invoice.numero_presupuesto || invoice.numero_factura || `#${invoice.id}`,
    fecha: invoice.fecha,
    clienteNombre: invoice.cliente_nombre || 'Consumidor Final',
    clienteTelefono: invoice.cliente_telefono,
    items: (invoice.items || []).map(it => ({
      cantidad: it.cantidad,
      descripcion: it.descripcion,
      precio_unitario: it.precio_unitario,
      total: it.total,
    })),
    total: invoice.total,
    faltantes,
    envio: invoice.envio ?? 0,
    retira: tipoEntrega === 'Retira',
    tipoEntrega,
    mode: invoice.tipo === 'BORRADOR' ? 'BORRADOR' : 'PRESUPUESTO',
  }
}
