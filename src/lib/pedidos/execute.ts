import {
  createInvoice,
  searchClients,
  createClient,
  nextInvoiceNumber,
  type InvoiceCreatedResult,
} from '@/lib/facbal/client'
import type { DescuentoState, PedidoItem, TipoEntrega } from './types'
import { isPhoneLikeClientName } from './client-identity'

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

/** Suma de los ítems cotizables (sin descuento). */
export function pedidoItemsNeto(items: PedidoItem[]): number {
  return cotizables(items).reduce((sum, it) => sum + it.cantidad * (it.precio_unitario ?? 0), 0)
}

/**
 * Crea el PRESUPUESTO en backend_gal. Defaults de galv2: envio=0,
 * tipo_entrega='Retira', estado_kanban='PEDIDO', user_id=0, tipo='PRESUPUESTO'.
 *
 * Si el flujo ya resolvió el cliente (`clienteId`), se usa directo; si no, se
 * busca por nombre y se crea cuando no existe. El descuento se manda como un
 * ítem `DESCUENTO` negativo (igual que galv2).
 */
export async function executePedido(args: {
  clienteNombre: string | null
  clienteId?: number | null
  clienteTelefono?: string | null
  clienteDomicilio?: string | null
  items: PedidoItem[]
  fecha?: string
  tipoEntrega?: TipoEntrega
  fechaEntrega?: string
  descuento?: DescuentoState | null
}): Promise<ExecutePedidoResult> {
  const validos = cotizables(args.items)
  if (validos.length === 0) {
    throw new Error('No hay ítems cotizables para armar el presupuesto.')
  }

  const nombreIngresado = (args.clienteNombre || '').trim()
  if (isPhoneLikeClientName(nombreIngresado)) {
    throw new Error('El teléfono del remitente no puede usarse como nombre de cliente.')
  }
  let clienteId: number | null = args.clienteId ?? null
  let clienteNombre = nombreIngresado || 'Consumidor Final'
  let clienteTelefono = args.clienteTelefono ?? null

  if (clienteId != null) {
    // Cliente ya elegido/confirmado por el flujo: no re-buscamos.
  } else if (nombreIngresado) {
    try {
      const existing = await searchClients(nombreIngresado)
      if (existing) {
        clienteId = existing.id
        clienteNombre = existing.nombre
        clienteTelefono = existing.telefono ?? clienteTelefono
      } else {
        const created = await createClient({ nombre: nombreIngresado })
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

  const neto = itemsPayload.reduce((sum, it) => sum + it.total, 0)
  let total = neto
  if (args.descuento && args.descuento.amount > 0) {
    const amount = Math.min(Math.round(args.descuento.amount), Math.round(neto))
    itemsPayload.push({
      cantidad: 1,
      descripcion: 'DESCUENTO',
      precio_unitario: -amount,
      total: -amount,
    })
    total = neto - amount
  }

  const invoice = await createInvoice({
    numero_factura: nextNum,
    numero_presupuesto: numeroPresupuesto,
    fecha: args.fecha || todayDDMMYYYY(),
    cliente_id: clienteId,
    cliente_nombre: clienteNombre,
    cliente_telefono: clienteTelefono || undefined,
    cliente_domicilio: args.clienteDomicilio?.trim() || undefined,
    items: itemsPayload,
    total,
    envio: 0,
    tipo: 'PRESUPUESTO',
    user_id: 0,
    tipo_entrega: args.tipoEntrega || 'Retira',
    fecha_entrega: args.fechaEntrega || '',
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
