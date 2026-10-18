// Núcleo de comprensión de pedidos (determinístico y compartido).
//
// Unifica lo que antes estaba duplicado (y divergía) entre la creación
// (`resolveAndSave`) y la cotización (`presentQuote`/`previewPedido`):
//   1. aplica el glosario aprendido,
//   2. clasifica y resuelve los ítems contra el catálogo,
//   3. separa los términos que BLOQUEAN la cotización de los cosméticos, y
//   4. detecta qué atributo falta (medida/variante) para cotizar.
//
// El precio y el catálogo siempre salen de los datos (`refs`/`rules`); acá no se
// inventa nada.

import type { PrecioReferencia, PricingRule } from '@/lib/precios'
import { applyOrderGlossary } from './glossary'
import type { OrderGlossaryEntry } from './glossary'
import { buildKnownVocab, classifyItem } from './classify-item'
import { resolveItems } from './resolve-items'
import type { ResolveResult } from './resolve-items'
import { resolveCatalogAttrs } from './catalog-attrs'
import { isGreetingRecipientName, isPhoneLikeClientName } from './client-identity'
import type { ParsedOrderItem } from './types'
import { DEFAULT_CATEGORIA } from '@/lib/catalog/defaults'

export interface ComprehendInput {
  items: ParsedOrderItem[]
  refs: PrecioReferencia[]
  rules: PricingRule[]
  glossary?: OrderGlossaryEntry[]
}

export interface MissingAttr {
  itemIndex: number
  /** Texto del ítem tal como quedó (con glosario aplicado). */
  term: string
  ask: 'medida' | 'variante'
  /** Opciones del catálogo (botones/lista). Vacío = pedir en texto libre. */
  options: string[]
}

export interface ComprehendResult {
  /** Ítems con el glosario ya aplicado (insumo de `resolveItems`). */
  items: ParsedOrderItem[]
  resolved: ResolveResult
  /** Términos desconocidos que dejan el producto sin reconocer (bloquean). */
  blockingTerms: string[]
  /** Atributos que faltan para cotizar productos ya reconocidos. */
  missing: MissingAttr[]
}

/**
 * Aplica glosario, resuelve precios, detecta términos que bloquean y atributos
 * faltantes. Un término desconocido solo "bloquea" si el ítem NO se reconoce
 * como producto/categoría; si el producto se entiende, las palabras extra
 * (color/marca) son cosméticas y se pide el atributo que falte.
 */
export function comprehendOrder(input: ComprehendInput): ComprehendResult {
  const glossary = input.glossary ?? []
  const items = applyOrderGlossary(input.items, glossary)
  const resolved = resolveItems({ items, refs: input.refs, rules: input.rules })

  const vocab = buildKnownVocab(input.refs, input.rules)
  const blockingTerms: string[] = []
  const missing: MissingAttr[] = []
  const seenTerms = new Set<string>()

  resolved.items.forEach((item, idx) => {
    if (!item.faltante || item.libre) return
    const texto = items[idx]?.texto ?? ''
    const cls = classifyItem(texto, vocab, glossary)
    const recognized = cls.categoria !== DEFAULT_CATEGORIA || cls.regla !== null

    // Producto sin reconocer → preguntar por la palabra (glosario).
    if (cls.unknownTerms.length > 0 && !recognized) {
      for (const term of cls.unknownTerms) {
        if (seenTerms.has(term)) continue
        seenTerms.add(term)
        blockingTerms.push(term)
      }
      return
    }

    // Producto reconocido (categoría explícita) → pedir la medida/variante que falta.
    if (cls.categoria !== DEFAULT_CATEGORIA) {
      const r = resolveCatalogAttrs(texto, cls.categoria, input.refs)
      if (!r.medida) {
        missing.push({ itemIndex: idx, term: texto, ask: 'medida', options: r.medidaOptions })
      } else if (!r.matched) {
        missing.push({ itemIndex: idx, term: texto, ask: 'variante', options: r.varianteOptions })
      }
      return
    }

    // Bastidor / regla sin medida → pedir dimensiones en texto libre.
    missing.push({ itemIndex: idx, term: texto, ask: 'medida', options: [] })
  })

  return { items, resolved, blockingTerms, missing }
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
