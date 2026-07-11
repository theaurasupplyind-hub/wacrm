import type { CartState } from './cart-state'

// ─── Tipos que reflejan el schema InvoiceCreate de backend_gal (main.py) ───

export interface InvoiceItemPayload {
  cantidad: number
  descripcion: string
  precio_unitario: number
  total: number
}

export interface InvoiceCreatePayload {
  numero_factura: string        // backend_gal genera el número atómicamente, acá va placeholder
  numero_presupuesto: string
  fecha: string                 // formato DD/MM/YYYY
  cliente_id: number | null
  cliente_nombre: string
  cliente_domicilio: string
  cliente_telefono: string
  items: InvoiceItemPayload[]
  total: number
  envio: number
  tipo: 'PRESUPUESTO' | 'FACTURA'
  user_id: number
  tipo_entrega: string
  fecha_entrega: string
  estado_kanban: string
}

// ─── Helper: genera la descripción de un item como la usa galv2-tauri ───
// Ej: "BASTIDOR 60x40 Lienzo Profesional"
function buildItemDescription(
  categoria: string,
  medida: string,
  variante: string,
): string {
  const parts = [categoria.toUpperCase(), medida]
  if (variante) parts.push(variante)
  return parts.join(' ')
}

// ─── Construye el payload para POST /invoices desde el carrito del chatbot ───
export function buildInvoicePayload(
  cart: CartState,
  phone: string,
  clienteNombre?: string,
): InvoiceCreatePayload {
  // Fecha en formato DD/MM/YYYY como espera backend_gal
  const hoy = new Date()
  const dia = String(hoy.getDate()).padStart(2, '0')
  const mes = String(hoy.getMonth() + 1).padStart(2, '0')
  const anio = hoy.getFullYear()
  const fecha = `${dia}/${mes}/${anio}`

  // Arma los items solo para los que tienen precio
  const items = cart.items
    .filter((i) => i.precio_unitario != null && i.subtotal != null)
    .map((i) => ({
      cantidad: i.cantidad,
      descripcion: buildItemDescription(i.categoria, i.medida, i.variante),
      precio_unitario: i.precio_unitario!,
      total: i.subtotal!,
    }))

  return {
    numero_factura: 'F-PREVIEW',  // placeholder, backend_gal genera el real
    numero_presupuesto: '',
    fecha,
    cliente_id: null,
    cliente_nombre: clienteNombre || `Cliente ${phone}`,
    cliente_domicilio: '',
    cliente_telefono: phone,
    items,
    total: items.reduce((sum, i) => sum + i.total, 0),
    envio: 0,
    tipo: 'PRESUPUESTO',
    user_id: 1,                  // user_id fijo para pruebas
    tipo_entrega: 'Retira',
    fecha_entrega: '',
    estado_kanban: 'PEDIDO',
  }
}
