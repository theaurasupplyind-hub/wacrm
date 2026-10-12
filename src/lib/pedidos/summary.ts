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

  // Nota: los supuestos (notaSupuestos) NO se muestran en el chat; quedan en
  // `order_context` y en la traza (bot_traces) para ver la cadena de decisión.

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

// Palabras que por sí solas significan confirmar/cancelar (normalizadas).
const CONFIRM_WORDS = new Set([
  'si', 'dale', 'ok', 'oka', 'okey', 'confirmo', 'confirmar', 'confirma', 'confirme',
  'confirmado', 'listo', 'perfecto', 'joya', 'bueno', 'va', 'vamos', 'hacelo',
  'hagamoslo', 'mandale', 'manda', 'sale', 'correcto', 'aprobado', 'acuerdo',
  'genial', 'buenisimo', 'bien', 'sisi',
])
const CANCEL_WORDS = new Set([
  'no', 'cancelar', 'cancela', 'cancelalo', 'cancelo', 'cancelalo', 'dejalo', 'deja',
  'olvidalo', 'olvidate', 'anular', 'anula', 'anulalo', 'nada', 'basta',
])
// Relleno: no aportan significado (se ignoran al clasificar).
const FILLER_WORDS = new Set([
  'el', 'la', 'los', 'las', 'lo', 'un', 'una', 'unos', 'unas', 'de', 'del',
  'presupuesto', 'pedido', 'ya', 'entonces', 'che', 'por', 'favor', 'todo', 'gracias',
])

/**
 * Clasifica la respuesta del usuario ante un pedido pendiente.
 * Robusto a frases compuestas ("si confirmo", "ok listo"), ignorando relleno.
 * Si queda contenido que no es sólo confirmación/cancelación → es una corrección.
 */
export function classifyOrderReply(text: string): PedidoReply {
  const tokens = normalizeCmd(text)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  const significant = tokens.filter(t => !FILLER_WORDS.has(t))
  if (significant.length === 0) return 'other'

  if (significant.some(t => CANCEL_WORDS.has(t))) {
    const rest = significant.filter(t => !CANCEL_WORDS.has(t))
    if (rest.length === 0) return 'cancel'
  }
  if (significant.every(t => CONFIRM_WORDS.has(t))) return 'confirm'
  return 'other'
}
