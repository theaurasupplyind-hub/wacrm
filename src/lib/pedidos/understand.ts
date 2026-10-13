// Núcleo de comprensión de pedidos (determinístico y compartido).
//
// Unifica lo que antes estaba duplicado (y divergía) entre la creación
// (`resolveAndSave`) y la cotización (`presentQuote`/`previewPedido`):
//   1. aplica el glosario aprendido,
//   2. clasifica y resuelve los ítems contra el catálogo,
//   3. separa los términos que BLOQUEAN la cotización (ítem sin precio con
//      vocabulario desconocido) de los cosméticos (color/marca/nota).
//
// El precio y el catálogo siempre salen de los datos (`refs`/`rules`); acá no se
// inventa nada.

import type { PrecioReferencia, PricingRule } from '@/lib/precios'
import { applyOrderGlossary } from './glossary'
import type { OrderGlossaryEntry } from './glossary'
import { buildKnownVocab, classifyItem } from './classify-item'
import { resolveItems } from './resolve-items'
import type { ResolveResult } from './resolve-items'
import { isGreetingRecipientName, isPhoneLikeClientName } from './client-identity'
import type { ParsedOrderItem } from './types'

export interface ComprehendInput {
  items: ParsedOrderItem[]
  refs: PrecioReferencia[]
  rules: PricingRule[]
  glossary?: OrderGlossaryEntry[]
}

export interface ComprehendResult {
  /** Ítems con el glosario ya aplicado (insumo de `resolveItems`). */
  items: ParsedOrderItem[]
  resolved: ResolveResult
  /** Términos desconocidos que dejan algún ítem sin cotizar (bloquean). */
  blockingTerms: string[]
}

/**
 * Aplica glosario, resuelve precios y detecta términos que bloquean. Los
 * términos desconocidos en ítems que igual se cotizaron se consideran cosméticos
 * y NO se devuelven (no interrumpen al usuario).
 */
export function comprehendOrder(input: ComprehendInput): ComprehendResult {
  const glossary = input.glossary ?? []
  const items = applyOrderGlossary(input.items, glossary)
  const resolved = resolveItems({ items, refs: input.refs, rules: input.rules })

  // `resolveItems` emite exactamente un ítem por ítem de entrada (mismo índice),
  // así que puedo mapear los faltantes de vuelta a su texto original.
  const vocab = buildKnownVocab(input.refs, input.rules)
  const blockingTerms: string[] = []
  const seen = new Set<string>()
  resolved.items.forEach((item, idx) => {
    if (!item.faltante) return
    for (const term of classifyItem(items[idx]?.texto ?? '', vocab, glossary).unknownTerms) {
      if (seen.has(term)) continue
      seen.add(term)
      blockingTerms.push(term)
    }
  })

  return { items, resolved, blockingTerms }
}

export interface ClientGuess {
  value: string | null
  source: 'explicit' | 'context' | 'inferred' | null
  suspicious: boolean
}

/**
 * Deduce el cliente del pedido. Nunca acepta el teléfono del remitente ni el
 * nombre del saludo ("Hola Jorge"): en esos casos cae al cliente previo del
 * contexto (si lo hay) y marca `suspicious`, para que la creación lo resuelva.
 */
export function resolveClientGuess(
  parsedCliente: string | null | undefined,
  text: string,
  contextName: string | null | undefined,
  senderPhone?: string | null,
): ClientGuess {
  const parsed = (parsedCliente || '').trim()
  let explicit: string | null = null
  let suspicious = false
  if (parsed) {
    if (isPhoneLikeClientName(parsed, senderPhone) || isGreetingRecipientName(parsed, text)) {
      suspicious = true
    } else {
      explicit = parsed
    }
  }
  if (explicit) return { value: explicit, source: 'explicit', suspicious: false }

  const ctx = (contextName || '').trim()
  if (ctx && !isPhoneLikeClientName(ctx, senderPhone)) {
    return { value: ctx, source: 'context', suspicious }
  }
  return { value: null, source: null, suspicious }
}
