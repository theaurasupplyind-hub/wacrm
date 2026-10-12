import type { OrderContext } from './types'

function money(n: number): string {
  return `$${n.toLocaleString('es-AR')}`
}

/** Arma el resumen del pedido que se le muestra al usuario (asumir y corregir). */
export function buildOrderSummary(ctx: OrderContext): string {
  const lines: string[] = ['Voy a armar este presupuesto:']
  const cotizables = ctx.items.filter(it => !it.faltante)
  cotizables.forEach((it, i) => {
    const cant = it.cantidad > 1 ? `${it.cantidad} x ` : ''
    const unit = it.cantidad > 1 && it.precio_unitario != null ? ` (${money(it.precio_unitario)} c/u)` : ''
    const flag = it.aRevisar ? ' ⚠️ a revisar' : ''
    lines.push(`${i + 1}. ${cant}${it.descripcion} — ${money(it.precio_unitario ?? 0)}${unit}${flag}`)
  })

  lines.push('')
  lines.push(`TOTAL: ${money(ctx.total)}`)

  if (ctx.notaSupuestos.length > 0) {
    lines.push('')
    lines.push('Asumí:')
    for (const n of ctx.notaSupuestos) lines.push(`• ${n}`)
  }

  if (ctx.faltantes.length > 0) {
    lines.push('')
    lines.push('Sin cotizar (los cotizamos a mano):')
    for (const f of ctx.faltantes) lines.push(`• ${f}`)
  }

  if (ctx.clienteNombre) lines.push(`\nCliente: ${ctx.clienteNombre}`)

  lines.push('')
  lines.push('¿Confirmás? (sí / corregí lo que quieras)')
  return lines.join('\n')
}

export type PedidoReply = 'confirm' | 'cancel' | 'other'

function normalizeCmd(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
}

/** Clasifica la respuesta del usuario ante un pedido pendiente. */
export function classifyOrderReply(text: string): PedidoReply {
  const t = normalizeCmd(text)
  if (/^(si|dale|ok|oka|okey|confirmo|confirmar|confirma|confirme|listo|perfecto|joya|de acuerdo|bueno|va|vamos|hacelo|hagamoslo|mandale|manda|si dale)$/.test(t)) {
    return 'confirm'
  }
  if (/^(no|cancelar|cancela|cancelalo|dejalo|deja|olvidalo|olvidate|anular|anula|no gracias|nada)$/.test(t)) {
    return 'cancel'
  }
  return 'other'
}
