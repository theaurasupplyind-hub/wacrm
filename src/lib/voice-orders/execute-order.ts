import type { VoiceOrderLog, PricedItem, ResolvedItem, VoiceOrderItem } from './types'
import { searchClients, createClient, bulkPrice, suggestPrice, createInvoice } from '../facbal/client'
import type { BulkPriceItem } from '../facbal/client'

function extractOriginalMedida(descripcion: string): string {
  const m = descripcion.match(/(\d+)\s*(?:[xX×]|por)\s*(\d+)/)
  return m ? `${m[1]}x${m[2]}` : ''
}

export async function searchOrCreateClient(
  nombre: string,
  telefono: string,
  logs: VoiceOrderLog[],
): Promise<{ id: number | null; nombre: string }> {
  const t0 = Date.now()

  const existing = await searchClients(nombre, telefono)
  if (existing) {
    logs.push({
      step: 'voice_client_search',
      data: { encontrado: true, id: existing.id, nombre: existing.nombre, duration_ms: Date.now() - t0 },
    })
    return { id: existing.id, nombre: existing.nombre }
  }

  const created = await createClient({ nombre, telefono })
  logs.push({
    step: 'voice_client_create',
    data: { id: created.id, nombre: created.nombre, duration_ms: Date.now() - t0 },
  })
  return { id: created.id, nombre: created.nombre }
}

export async function resolveItems(
  items: VoiceOrderItem[],
  logs: VoiceOrderLog[],
): Promise<ResolvedItem[]> {
  const t0 = Date.now()
  const resolved: ResolvedItem[] = []

  for (const item of items) {
    try {
      const result = await suggestPrice(item.descripcion)
      const sug = result.items?.[0]
      const firstDetalle = result.detalles?.[0]

      // Detectar variantes disponibles desde sugerencias
      const variantes = [...new Set(
        (result.sugerencias ?? [])
          .map(s => s.variante?.trim().toLowerCase())
          .filter(Boolean)
      )]
      const descLower = item.descripcion.toLowerCase()
      const varianteMencionada = variantes.some(v => descLower.includes(v))
      const hasMultipleVariants = !varianteMencionada && variantes.length > 1

      // Caso 1: precio único resuelto (sin ambigüedad de variante)
      if (sug && sug.categoria && sug.precio != null && !sug.faltante && !hasMultipleVariants) {
        resolved.push({
          descripcion: item.descripcion,
          cantidad: item.cantidad,
          categoria: sug.categoria,
          medida: extractOriginalMedida(item.descripcion) || sug.medida,
          variante: sug.variante || '',
          precio_base: sug.precio,
          medida_referencia: result.medida_encontrada,
          faltante: false,
        })
        continue
      }

      // Caso 2: múltiples variantes disponibles (pedir que especifique)
      if (hasMultipleVariants && variantes.length > 0 && firstDetalle) {
        const cat = firstDetalle.categoria || 'BASTIDOR'
        resolved.push({
          descripcion: item.descripcion,
          cantidad: item.cantidad,
          categoria: cat,
          medida: extractOriginalMedida(item.descripcion) || result.medida_encontrada || '',
          variante: '',
          precio_base: firstDetalle.precio,
          medida_referencia: result.medida_encontrada,
          faltante: false,
          necesita_variante: true,
          variantes_disponibles: variantes,
        })
        continue
      }

      // Caso 3: la medida existe pero hay data en sugerencias (índice de catálogo)
      if (result.sugerencias?.length > 0 && firstDetalle) {
        resolved.push({
          descripcion: item.descripcion,
          cantidad: item.cantidad,
          categoria: firstDetalle.categoria || 'BASTIDOR',
          medida: extractOriginalMedida(item.descripcion) || result.medida_encontrada || '',
          variante: firstDetalle.variante || '',
          precio_base: firstDetalle.precio,
          medida_referencia: result.medida_encontrada,
          faltante: firstDetalle.precio == null,
          necesita_variante: variantes.length > 1 && !varianteMencionada,
          variantes_disponibles: variantes.length > 1 && !varianteMencionada ? variantes : undefined,
        })
        continue
      }

      // Caso 4: sin resultados — reintentar como bastidor si la descripción tiene medidas
      const tieneMedidas = /(?:\d+\s*(?:[xX×]|por)\s*\d+)/.test(item.descripcion)
      if (tieneMedidas && (!sug || !sug.categoria || sug.faltante)) {
        const result2 = await suggestPrice(`bastidor ${item.descripcion}`)
        const sug2 = result2.items?.[0]
        const det2 = result2.detalles?.[0]
        const var2 = [...new Set(
          (result2.sugerencias ?? []).map(s => s.variante?.trim().toLowerCase()).filter(Boolean)
        )]
        const dLow2 = item.descripcion.toLowerCase()
        const varMen2 = var2.some(v => dLow2.includes(v))

        if (sug2 && sug2.categoria && sug2.precio != null && !sug2.faltante) {
          if (var2.length > 1 && !varMen2) {
            resolved.push({
              descripcion: item.descripcion, cantidad: item.cantidad,
              categoria: sug2.categoria, medida: extractOriginalMedida(item.descripcion) || sug2.medida,
              variante: '', precio_base: sug2.precio,
              medida_referencia: result2.medida_encontrada, faltante: false,
              necesita_variante: true, variantes_disponibles: var2,
            })
          } else {
            resolved.push({
              descripcion: item.descripcion, cantidad: item.cantidad,
              categoria: sug2.categoria, medida: extractOriginalMedida(item.descripcion) || sug2.medida,
              variante: sug2.variante || '', precio_base: sug2.precio,
              medida_referencia: result2.medida_encontrada, faltante: false,
            })
          }
          continue
        }
        if (det2 && var2.length > 1 && !varMen2) {
          resolved.push({
            descripcion: item.descripcion, cantidad: item.cantidad,
            categoria: det2.categoria || 'BASTIDOR', medida: extractOriginalMedida(item.descripcion) || result2.medida_encontrada || '',
            variante: '', precio_base: det2.precio,
            medida_referencia: result2.medida_encontrada, faltante: false,
            necesita_variante: true, variantes_disponibles: var2,
          })
          continue
        }
      }

      resolved.push({
        descripcion: item.descripcion,
        cantidad: item.cantidad,
        categoria: 'PRODUCTO',
        medida: '',
        variante: '',
        precio_base: null,
        medida_referencia: null,
        faltante: true,
      })
    } catch {
      // Reintentar como bastidor si tiene medidas
      if (/(?:\d+\s*(?:[xX×]|por)\s*\d+)/.test(item.descripcion)) {
        try {
          const result2 = await suggestPrice(`bastidor ${item.descripcion}`)
          const sug2 = result2.items?.[0]
          const det2 = result2.detalles?.[0]
          const var2 = [...new Set(
            (result2.sugerencias ?? []).map(s => s.variante?.trim().toLowerCase()).filter(Boolean)
          )]
          const dLow2 = item.descripcion.toLowerCase()
          const varMen2 = var2.some(v => dLow2.includes(v))
          if (sug2 && sug2.categoria && sug2.precio != null && !sug2.faltante) {
            resolved.push({
              descripcion: item.descripcion, cantidad: item.cantidad,
              categoria: sug2.categoria, medida: extractOriginalMedida(item.descripcion) || sug2.medida,
              variante: sug2.variante || '', precio_base: sug2.precio,
              medida_referencia: result2.medida_encontrada, faltante: false,
              necesita_variante: var2.length > 1 && !varMen2,
              variantes_disponibles: var2.length > 1 && !varMen2 ? var2 : undefined,
            })
            continue
          }
        } catch { /* ignore */ }
      }
      resolved.push({
        descripcion: item.descripcion,
        cantidad: item.cantidad,
        categoria: 'PRODUCTO',
        medida: '',
        variante: '',
        precio_base: null,
        medida_referencia: null,
        faltante: true,
      })
    }
  }

  logs.push({
    step: 'voice_resolve',
    data: {
      items_count: resolved.length,
      items: resolved.map(i => ({
        descripcion: i.descripcion,
        categoria: i.categoria,
        precio_base: i.precio_base,
        faltante: i.faltante,
      })),
      duration_ms: Date.now() - t0,
    },
  })

  return resolved
}

export async function priceItems(
  resolvedItems: ResolvedItem[],
  logs: VoiceOrderLog[],
): Promise<{ items: PricedItem[]; total: number }> {
  const t0 = Date.now()

  const bulkItems: BulkPriceItem[] = resolvedItems
    .filter(r => !r.faltante && r.categoria !== 'PRODUCTO')
    .map(r => ({
      categoria: r.categoria,
      medida: r.medida,
      variante: r.variante || null,
      cantidad: r.cantidad,
    }))

  let priced: PricedItem[] = []

  if (bulkItems.length > 0) {
    const result = await bulkPrice(bulkItems, 90_000)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    priced = result.items.map((r: any) => ({
      cantidad: r.cantidad,
      categoria: r.categoria,
      variante: r.variante,
      medida_solicitada: r.medida_solicitada,
      medida_referencia: r.medida_referencia,
      precio: r.precio,
      faltante: r.faltante,
      precio_base: r.precio_base ?? null,
      regla_aplicada: r.regla_aplicada ?? null,
    }))
  }

  // Add items that couldn't be resolved
  const unresolved = resolvedItems.filter(r => r.faltante || r.categoria === 'PRODUCTO')
  for (const r of unresolved) {
    priced.push({
      cantidad: r.cantidad,
      categoria: r.categoria,
      variante: r.variante,
      medida_solicitada: r.medida,
      medida_referencia: r.medida_referencia || r.medida,
      precio: null,
      faltante: true,
      precio_base: null,
      regla_aplicada: null,
    })
  }

  const total = priced.reduce((sum, i) => sum + (i.precio ?? 0) * i.cantidad, 0)
  const faltantes = priced.filter(i => i.faltante)

  logs.push({
    step: 'voice_pricing',
    data: {
      items_count: priced.length,
      faltantes: faltantes.length,
      total,
      duration_ms: Date.now() - t0,
      detalles: priced.map(i => ({
        item: `${i.cantidad}x ${i.categoria} ${i.medida_solicitada}${i.variante ? ` (${i.variante})` : ''}`,
        precio_base: i.precio_base,
        regla_aplicada: i.regla_aplicada,
        precio_final: i.precio,
        medida_referencia: i.medida_referencia,
      })),
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

  const faltantes = items.filter(i => i.faltante)
  for (const f of faltantes) {
    invoiceItems.push({
      cantidad: f.cantidad,
      descripcion: `${f.categoria} ${f.medida_solicitada}${f.variante ? ` ${f.variante}` : ''} (SIN PRECIO)`,
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
    numero_presupuesto: `BOT-${Date.now().toString(36).toUpperCase()}`,
  })

  logs.push({
    step: 'voice_invoice',
    data: { numero: result.numero_factura, id: result.id, total, duration_ms: Date.now() - t0 },
  })

  return { numero: result.numero_factura, id: result.id }
}
