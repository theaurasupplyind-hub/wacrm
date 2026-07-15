import type { VoiceOrderLog, ParsedOrder, PricedItem, VoiceOrderItem } from './types'
import { searchClients, createClient, bulkPrice, createInvoice } from '../facbal/client'
import type { BulkPriceItem } from '../facbal/client'

export async function searchOrCreateClient(
  nombre: string,
  telefono: string,
  logs: VoiceOrderLog[],
): Promise<{ id: number | null; nombre: string }> {
  const t0 = Date.now()

  // Buscar cliente existente
  const existing = await searchClients(nombre, telefono)
  if (existing) {
    logs.push({
      step: 'voice_client_search',
      data: { encontrado: true, id: existing.id, nombre: existing.nombre, duration_ms: Date.now() - t0 },
    })
    return { id: existing.id, nombre: existing.nombre }
  }

  // Crear cliente nuevo
  const created = await createClient({ nombre, telefono })
  logs.push({
    step: 'voice_client_create',
    data: { id: created.id, nombre: created.nombre, duration_ms: Date.now() - t0 },
  })
  return { id: created.id, nombre: created.nombre }
}

export async function priceItems(
  items: VoiceOrderItem[],
  logs: VoiceOrderLog[],
): Promise<{ items: PricedItem[]; total: number }> {
  const t0 = Date.now()

  const bulkItems: BulkPriceItem[] = items.map(i => ({
    categoria: i.categoria,
    medida: i.medida,
    variante: i.variante || null,
    cantidad: i.cantidad,
  }))

  const result = await bulkPrice(bulkItems, 90_000)

  const priced: PricedItem[] = result.items.map(r => ({
    cantidad: r.cantidad,
    categoria: r.categoria,
    variante: r.variante,
    medida_solicitada: r.medida_solicitada,
    medida_referencia: r.medida_referencia,
    precio: r.precio,
    faltante: r.faltante,
  }))

  const total = priced.reduce((sum, i) => sum + (i.precio ?? 0) * i.cantidad, 0)
  const faltantes = priced.filter(i => i.faltante)

  logs.push({
    step: 'voice_pricing',
    data: {
      items_count: priced.length,
      faltantes: faltantes.length,
      total,
      duration_ms: Date.now() - t0,
    },
  })

  return { items: priced, total }
}

export async function createPresupuesto(
  client: { id: number | null; nombre: string },
  items: PricedItem[],
  logs: VoiceOrderLog[],
): Promise<{ numero: string; id: number }> {
  const t0 = Date.now()

  const invoiceItems = items
    .filter(i => i.precio != null)
    .map(i => ({
      cantidad: i.cantidad,
      descripcion: `${i.categoria} ${i.medida_solicitada}${i.variante ? ` ${i.variante}` : ''}`,
      precio_unitario: i.precio!,
      total: i.precio! * i.cantidad,
    }))

  const total = invoiceItems.reduce((s, i) => s + i.total, 0)

  // Si hay items faltantes, agregarlos como items sin precio para que quede registro
  const faltantes = items.filter(i => i.faltante)
  for (const f of faltantes) {
    invoiceItems.push({
      cantidad: f.cantidad,
      descripcion: `${f.categoria} ${f.medida_solicitada}${f.variante ? ` ${f.variante}` : ''} (SIN PRECIO - consultar con agente)`,
      precio_unitario: 0,
      total: 0,
    })
  }

  const hoy = new Date()
  const fecha = `${hoy.getDate().toString().padStart(2, '0')}/${(hoy.getMonth() + 1).toString().padStart(2, '0')}/${hoy.getFullYear()}`

  const result = await createInvoice({
    numero_factura: '',
    fecha,
    cliente_id: client.id,
    cliente_nombre: client.nombre,
    cliente_telefono: '',
    items: invoiceItems,
    total,
    envio: 0,
    tipo: 'PRESUPUESTO',
    user_id: 1,
  })

  logs.push({
    step: 'voice_invoice',
    data: { numero: result.numero_factura, id: result.id, total, duration_ms: Date.now() - t0 },
  })

  return { numero: result.numero_factura, id: result.id }
}
