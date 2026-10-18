// Preview read-only del pedido (para bot-beta y el tool de cotización): parsea +
// comprende (glosario + resolución) + resumen, SIN enviar WhatsApp, SIN escribir
// contexto y SIN crear el presupuesto.

import { getPreciosReferencia, getPricingRules } from '@/lib/facbal/client'
import type { PrecioReferencia, PricingRule } from '@/lib/precios'
import { buildVocabulary } from '@/lib/catalog/vocabulary'
import { parseOrder } from './parse-order'
import { comprehendOrder, resolveClientGuess } from './understand'
import { buildOrderSummary } from './summary'
import type { OrderGlossaryEntry } from './glossary'
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
    /** Glosario aprendido (si se pasa, se aplica igual que en la creación). */
    glossary?: OrderGlossaryEntry[]
    senderPhone?: string | null
    /** Inyección para tests: parseo (evita llamar al LLM). */
    parseFn?: (text: string, context: OrderContext | null) => Promise<ParsedOrder>
  } = {},
): Promise<PedidoPreview | null> {
  // Catálogo antes del parseo: alimenta el vocabulario del prompt (Plan A2).
  const refs = opts.refs ?? (await getPreciosReferencia())
  const rules = opts.rules ?? (await getPricingRules())
  const parsed = opts.parseFn
    ? await opts.parseFn(text, opts.context ?? null)
    : await parseOrder(text, { context: opts.context ?? null, vocab: buildVocabulary(refs, rules) })
  if (parsed.items.length === 0) return null

  const { resolved } = comprehendOrder({
    items: parsed.items,
    refs,
    rules,
    glossary: opts.glossary ?? [],
  })
  if (resolved.items.length === 0) return null

  const clienteNombre = resolveClientGuess(
    parsed.cliente,
    text,
    opts.context?.clienteNombre,
    opts.senderPhone,
  ).value

  const ctx: OrderContext = {
    stage: 'confirming',
    items: resolved.items,
    clienteNombre,
    total: resolved.total,
    faltantes: resolved.faltantes,
    notaSupuestos: resolved.notaSupuestos,
  }
  return {
    text: buildOrderSummary(ctx, { confirm: false, title: 'Cotización estimada:' }),
    total: resolved.total,
    items: resolved.items,
    faltantes: resolved.faltantes,
    clienteNombre,
  }
}
