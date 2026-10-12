import {
  createInvoice,
  searchClients,
  createClient,
  nextInvoiceNumber,
  type InvoiceCreatedResult,
} from '@/lib/facbal/client'
import type { PedidoItem } from './types'

export interface ExecutePedidoResult {
  invoice: InvoiceCreatedResult
  numeroPresupuesto: string
  clienteId: number | null
  clienteNombre: string
  total: number
  faltantes: PedidoItem[]
}

function todayDDMMYYYY(): string {
  const d = new Date()
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  return `${dd}/${mm}/${d.getFullYear()}`
}

function cotizables(items: PedidoItem[]): PedidoItem[] {
  return items.filter(it => !it.faltante && it.precio_unitario != null)
}

/**
 * Crea el PRESUPUESTO en backend_gal. Defaults de galv2: envio=0,
 * tipo_entrega='Retira', estado_kanban='PEDIDO', user_id=0, tipo='PRESUPUESTO'.
 * El cliente se busca por nombre; si no existe se crea.
 */
export async function executePedido(args: {
  clienteNombre: string | null
  items: PedidoItem[]
  senderPhone?: string | null
  fecha?: string
}): Promise<ExecutePedidoResult> {
  const validos = cotizables(args.items)
  if (validos.length === 0) {
    throw new Error('No hay ítems cotizables para armar el presupuesto.')
  }

  const nombreIngresado = (args.clienteNombre || '').trim()
  let clienteId: number | null = null
  let clienteNombre = nombreIngresado || 'Consumidor Final'

  if (nombreIngresado) {
    try {
      const existing = await searchClients(nombreIngresado, args.senderPhone || undefined)
      if (existing) {
        clienteId = existing.id
        clienteNombre = existing.nombre
      } else {
        const created = await createClient({
          nombre: nombreIngresado,
          telefono: args.senderPhone || undefined,
        })
        clienteId = created.id
        clienteNombre = created.nombre
      }
    } catch (err) {
      console.error('[pedido] cliente no resuelto, se crea el presupuesto sin vínculo:', err)
    }
  }

  const nextNum = await nextInvoiceNumber('F')
  const numeroPresupuesto = nextNum.replace('F', 'P')

  const itemsPayload = validos.map(it => {
    const precio = it.precio_unitario ?? 0
    return {
      cantidad: it.cantidad,
      descripcion: it.descripcion,
      precio_unitario: precio,
      total: it.cantidad * precio,
    }
  })
  const total = itemsPayload.reduce((sum, it) => sum + it.total, 0)

  const invoice = await createInvoice({
    numero_factura: nextNum,
    numero_presupuesto: numeroPresupuesto,
    fecha: args.fecha || todayDDMMYYYY(),
    cliente_id: clienteId,
    cliente_nombre: clienteNombre,
    cliente_telefono: args.senderPhone || undefined,
    items: itemsPayload,
    total,
    envio: 0,
    tipo: 'PRESUPUESTO',
    user_id: 0,
    tipo_entrega: 'Retira',
    estado_kanban: 'PEDIDO',
  })

  return {
    invoice,
    numeroPresupuesto,
    clienteId,
    clienteNombre,
    total,
    faltantes: args.items.filter(it => it.faltante),
  }
}
