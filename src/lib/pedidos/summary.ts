import type { DescuentoState, OrderContext, TipoEntrega } from './types'
import { formatFechaEntregaDisplay } from './dates'
import { classifyReply } from '@/lib/bot-llm/reply-intent'

function money(n: number): string {
  return `$${n.toLocaleString('es-AR')}`
}

/** Bloque de ítems + TOTAL (sin datos de entrega ni confirmación). */
function buildItemsBlock(ctx: OrderContext, title: string): string[] {
  const lines: string[] = [title]
  const cotizables = ctx.items.filter(it => !it.faltante)
  cotizables.forEach((it, i) => {
    const cant = it.cantidad > 1 ? `${it.cantidad} x ` : ''
    const unit = it.cantidad > 1 && it.precio_unitario != null ? ` (${money(it.precio_unitario)} c/u)` : ''
    const flag = it.aRevisar ? ' ⚠️ a revisar' : ''
    const manual = it.libre ? ' (manual)' : ''
    lines.push(`${i + 1}. ${cant}${it.descripcion}${manual} — ${money(it.precio_unitario ?? 0)}${unit}${flag}`)
  })

  lines.push('')
  lines.push(`TOTAL: ${money(ctx.total)}`)

  if (ctx.faltantes.length > 0) {
    lines.push('')
    lines.push('Sin cotizar (los cotizamos a mano):')
    for (const f of ctx.faltantes) lines.push(`• ${f}`)
  }

  return lines
}

function buildDeliveryBlock(ctx: OrderContext): string[] {
  const lines: string[] = []
  if (ctx.clienteNombre) {
    lines.push(`${ctx.clienteId === null ? 'Cliente nuevo' : 'Cliente'}: ${ctx.clienteNombre}`)
  }
  if (ctx.tipoEntrega) lines.push(`Entrega: ${ctx.tipoEntrega}`)
  if (ctx.clienteDomicilio) lines.push(`Domicilio: ${ctx.clienteDomicilio}`)
  const fecha = formatFechaEntregaDisplay(ctx.fechaEntrega)
  if (fecha) lines.push(`Fecha de entrega: ${fecha}`)
  if (ctx.descuento) {
    const label = ctx.descuento.mode === 'percent' ? `${ctx.descuento.value}%` : money(ctx.descuento.value)
    lines.push(`Descuento: ${label} (resta ${money(ctx.descuento.amount)})`)
  }
  return lines
}

/**
 * Arma el resumen del pedido. Con `confirm` (default) cierra con la pregunta
 * de confirmación; durante la recolección de datos se usa `confirm: false` y
 * un `prompt` con la siguiente pregunta.
 */
export function buildOrderSummary(
  ctx: OrderContext,
  opts: { confirm?: boolean; prompt?: string; title?: string } = {},
): string {
  const confirm = opts.confirm ?? true
  const lines = buildItemsBlock(ctx, opts.title ?? 'Voy a armar este presupuesto:')

  const delivery = buildDeliveryBlock(ctx)
  if (delivery.length > 0) {
    lines.push('')
    lines.push(...delivery)
  }

  // Nota: los supuestos (notaSupuestos) NO se muestran en el chat; quedan en
  // `order_context` y en la traza (bot_traces) para ver la cadena de decisión.

  if (opts.prompt) {
    lines.push('')
    lines.push(opts.prompt)
  }

  if (confirm) {
    lines.push('')
    lines.push('¿Confirmás? (sí / corregí lo que quieras)')
  }
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

/**
 * Clasifica la respuesta del usuario ante un pedido pendiente.
 * Delega en el módulo único (`bot-llm/reply-intent.ts`, fix #4): simétrico
 * some/some — "sí + verbo que repite la oferta" confirma; contenido nuevo
 * (medidas, cambios, "pero") es corrección.
 */
export function classifyOrderReply(text: string): PedidoReply {
  return classifyReply(text)
}

/** Interpreta la respuesta de tipo de entrega ("retira", "envío", "las dos"). */
export function classifyEntrega(text: string): TipoEntrega | null {
  const t = normalizeCmd(text)
  if (!t) return null
  const both =
    /ret\+?\s*env/.test(t) || /\b(?:las dos|los dos|ambas|ambos)\b/.test(t)
  const ret =
    /\bret(?:ira|iro|irar|iralo|iramos)\b/.test(t) ||
    /\bpaso a (?:buscar|retirar)\b/.test(t)
  const env =
    /\benvi(?:o|os|ar|a|alo|arlo|amos)\b/.test(t) ||
    /\bmand(?:o|as|a|ar|arlo|alo|amos)\b/.test(t)
  if (both || (ret && env)) return 'Retiro y Envio'
  if (env) return 'Envio'
  if (ret) return 'Retira'
  return null
}

/**
 * Clasifica una respuesta sí/no (para confirmar el cliente candidato).
 * Delegado al módulo único de intención de respuesta (`bot-llm/reply-intent.ts`).
 */
export { classifyYesNo } from '@/lib/bot-llm/reply-intent'

const SKIP_DESCUENTO_RE = /\b(no|nada|ninguno|ninguna|sin descuento|saltear|salteo|omitir|despues|luego|paso)\b/

/**
 * Interpreta la respuesta del descuento. Devuelve:
 *  - `'skip'` si el usuario dijo que no
 *  - un `DescuentoState` si dio monto o porcentaje
 *  - `null` si no se entiende
 */
export function parseDescuento(text: string, baseTotal: number): DescuentoState | 'skip' | null {
  const t = normalizeCmd(text)
  if (!t) return null
  if (SKIP_DESCUENTO_RE.test(t) && !/\d/.test(t)) return 'skip'

  const pct = t.match(/(\d+(?:[.,]\d+)?)\s*%/)
  if (pct) {
    const value = parseFloat(pct[1].replace(',', '.'))
    if (Number.isFinite(value) && value > 0 && value <= 100) {
      return { mode: 'percent', value, amount: Math.round((baseTotal * value) / 100) }
    }
    return null
  }

  const amountRaw = t.match(/\$?\s*(\d+(?:[.,]\d+)?)/)
  if (amountRaw) {
    const value = parseFloat(amountRaw[1].replace(',', '.'))
    if (!Number.isFinite(value)) return null
    if (value <= 0) return 'skip'
    return { mode: 'amount', value, amount: Math.round(value) }
  }
  return null
}
