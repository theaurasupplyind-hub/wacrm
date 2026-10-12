// Preview read-only del pedido (para bot-beta): parsea + resuelve + resumen,
// SIN enviar WhatsApp, SIN escribir contexto y SIN crear el presupuesto.

import { getPreciosReferencia, getPricingRules } from '@/lib/facbal/client'
import type { PrecioReferencia, PricingRule } from '@/lib/precios'
import { parseOrder } from './parse-order'
import { resolveItems } from './resolve-items'
import { buildOrderSummary } from './summary'
import type { OrderContext, ParsedOrder, PedidoItem } from './types'

export interface PedidoPreview {
  text: string
  total: number
  items: PedidoItem[]
  faltantes: string[]
  clienteNombre: string | null
}

export async function previewPedido(
  text: string,
  opts: {
    context?: OrderContext | null
    refs?: PrecioReferencia[]
    rules?: PricingRule[]
    /** Inyección para tests: parseo (evita llamar al LLM). */
    parseFn?: (text: string, context: OrderContext | null) => Promise<ParsedOrder>
  } = {},
): Promise<PedidoPreview | null> {
  const parsed = opts.parseFn
    ? await opts.parseFn(text, opts.context ?? null)
    : await parseOrder(text, { context: opts.context ?? null })
  if (parsed.items.length === 0) return null

  const refs = opts.refs ?? (await getPreciosReferencia())
  const rules = opts.rules ?? (await getPricingRules())
  const resolved = resolveItems({ items: parsed.items, refs, rules })
  if (resolved.items.length === 0) return null

  const ctx: OrderContext = {
    stage: 'confirming',
    items: resolved.items,
    clienteNombre: parsed.cliente ?? opts.context?.clienteNombre ?? null,
    total: resolved.total,
    faltantes: resolved.faltantes,
    notaSupuestos: resolved.notaSupuestos,
  }
  return {
    text: buildOrderSummary(ctx, { confirm: false, title: 'Cotización estimada:' }),
    total: resolved.total,
    items: resolved.items,
    faltantes: resolved.faltantes,
    clienteNombre: parsed.cliente ?? opts.context?.clienteNombre ?? null,
  }
}
