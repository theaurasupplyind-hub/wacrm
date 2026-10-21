// Resolución determinística de precios por ítem. "Asume y corrige": nunca
// bloquea con preguntas, elige el mejor candidato y anota los supuestos.
//
// El "entendimiento" del texto lo hace `classify-item.ts` (vocabulario del
// catálogo); al motor de precios se le pasa una consulta CANÓNICA
// ("categoria medida variante regla"), así unidades/relleno/orden/sinónimos no
// rompen el match de candidatos.

import { suggestPrice, refsToProductos, catalogBounds, buildSuggestionDesc, roundDim } from '@/lib/precios'
import type { PrecioReferencia, PricingRule, Producto, PriceSuggestion } from '@/lib/precios'
import { buildKnownVocab, classifyItem, stripOtherVariants } from './classify-item'
import { resolveCatalogAttrs } from './catalog-attrs'
import type { ParsedOrderItem, PedidoItem } from './types'
import { DEFAULT_CATEGORIA } from '@/lib/catalog/defaults'

export interface ResolveResult {
  items: PedidoItem[]
  total: number
  faltantes: string[]
  notaSupuestos: string[]
}

function medidaFromText(text: string): { s: number; l: number } | null {
  const m = (text || '').match(/(\d+(?:[.,]\d+)?)\s*[xX×*]\s*(\d+(?:[.,]\d+)?)/)
  if (!m) return null
  const a = parseFloat(m[1].replace(',', '.'))
  const b = parseFloat(m[2].replace(',', '.'))
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return { s: Math.min(a, b), l: Math.max(a, b) }
}

function productFromBasedOn(basedOn: string | undefined, productos: Producto[]): Producto | null {
  if (!basedOn) return null
  return productos.find(p => p.descripcion === basedOn) ?? null
}

function cap(text: string): string {
  if (!text) return text
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function etiqueta(cantidad: number, texto: string): string {
  return `${cantidad > 1 ? `${cantidad}× ` : ''}"${texto}"`
}

function describe(categoria: string, medida: string, variante: string | null): string {
  return `${cap(categoria)} ${medida}${variante ? ` ${variante}` : ''}`.replace(/\s+/g, ' ').trim()
}

/**
 * Línea manual de un ítem fuera de catálogo (producto aprendido, muestra sin
 * medida, nombre propio). Precio propio del usuario o `faltante` para cotizar a
 * mano. Fuente única para los dos caminos que la emiten.
 */
function manualLine(cantidad: number, texto: string, precioRaw: number | null | undefined): PedidoItem {
  const precio =
    typeof precioRaw === 'number' && Number.isFinite(precioRaw) && precioRaw >= 0
      ? Math.round(precioRaw)
      : null
  return {
    cantidad,
    categoria: 'LIBRE',
    medida: null,
    variante: null,
    precio_unitario: precio,
    faltante: precio == null,
    descripcion: cap(texto),
    regla_aplicada: null,
    asumido: 'ítem fuera de catálogo',
    libre: true,
  }
}

/**
 * Cotiza un producto "por atributo" (categorías que no se miden en `AxB`:
 * acrílico, circulares, rollo de tela) cuando el texto ya alcanza para
 * determinarlo (categoría + medida + variante únicas en el catálogo).
 */
function resolveByAttr(
  cantidad: number,
  texto: string,
  categoria: string,
  refs: PrecioReferencia[],
): { item: PedidoItem; total: number } | null {
  if (categoria === DEFAULT_CATEGORIA) return null
  const resolved = resolveCatalogAttrs(texto, categoria, refs)
  const m = resolved.matched
  if (!m) return null
  return {
    item: {
      cantidad,
      categoria: m.categoria,
      medida: m.medida,
      variante: m.variante || null,
      precio_unitario: m.precio,
      faltante: false,
      descripcion: describe(m.categoria, m.medida, m.variante || null),
      regla_aplicada: null,
      asumido: null,
    },
    total: m.precio * cantidad,
  }
}

export function resolveItems(args: {
  items: ParsedOrderItem[]
  refs: PrecioReferencia[]
  rules: PricingRule[]
}): ResolveResult {
  const { items, refs, rules } = args
  const productos = refsToProductos(refs)
  const bounds = catalogBounds(refs)
  const vocab = buildKnownVocab(refs, rules)
  const rulesByName = new Map(rules.map(r => [r.name, r]))
  const ruleNames = new Set(rules.map(r => r.name))

  const resolved: PedidoItem[] = []
  const notaSupuestos: string[] = []
  const faltantes: string[] = []
  let total = 0

  const pushFaltante = (cantidad: number, texto: string) => {
    resolved.push({
      cantidad,
      categoria: DEFAULT_CATEGORIA,
      medida: null,
      variante: null,
      precio_unitario: null,
      faltante: true,
      descripcion: texto || '(sin descripción)',
      regla_aplicada: null,
      asumido: null,
    })
    faltantes.push(etiqueta(cantidad, texto || '(sin descripción)'))
  }

  for (const raw of items) {
    const cantidad = Number.isFinite(raw.cantidad) && raw.cantidad > 0 ? Math.floor(raw.cantidad) : 1
    const texto = (raw.texto || '').trim()
    const cls = classifyItem(texto, vocab)

    // `libre` explícito (muestra sin medida / producto aprendido fuera de
    // catálogo): SIEMPRE línea manual, aunque el texto arrastre una medida
    // ("palos de metal 60x40" no es un bastidor). Antes esto solo aplicaba sin
    // medida y el ítem se recotizaba como bastidor.
    if (raw.libre === true) {
      const item = manualLine(cantidad, texto, raw.precio)
      resolved.push(item)
      if (item.faltante) faltantes.push(etiqueta(cantidad, texto))
      else total += (item.precio_unitario ?? 0) * cantidad
      continue
    }

    if (!cls.medida) {
      const byAttr = resolveByAttr(cantidad, texto, cls.categoria, refs)
      if (byAttr) {
        resolved.push(byAttr.item)
        total += byAttr.total
        continue
      }
      // Ítem FUERA DE CATÁLOGO: nombre propio no reconocido (2+ términos) o con
      // precio explícito del usuario. Se cotiza como LÍNEA MANUAL; nunca se asume
      // "BASTIDOR" por default (bug "Palos de metal" / R3).
      const isFree =
        cls.categoria === DEFAULT_CATEGORIA &&
        !cls.regla &&
        (cls.unknownTerms.length >= 2 || (raw.precio != null && cls.unknownTerms.length >= 1))
      if (isFree) {
        const item = manualLine(cantidad, texto, raw.precio)
        resolved.push(item)
        if (item.faltante) faltantes.push(etiqueta(cantidad, texto))
        else total += (item.precio_unitario ?? 0) * cantidad
        continue
      }
      pushFaltante(cantidad, texto)
      continue
    }

    const { s, l } = cls.medida
    const rds = roundDim(s)
    const rdl = roundDim(l)
    const medidaPedida = `${s} x ${l}`
    const medidaCanonica = `${s} x ${l}${cls.grosor != null ? ` x ${cls.grosor}` : ''}`
    const canonical = [cls.categoria, medidaCanonica, cls.variante, cls.regla?.name]
      .filter(Boolean)
      .join(' ')

    const sugerencias = suggestPrice(canonical, productos, rules)
    const ruleSugs = sugerencias.filter(x => {
      if (!x.suggested || !ruleNames.has(x.description)) return false
      // Las reglas del catálogo se basan en una categoría; no aplican a otra
      // (p.ej. la regla "Sin Tela" no debe tomar un "rollo de tela").
      const rule = rulesByName.get(x.description)
      return !rule?.baseCategoria || rule.baseCategoria.toUpperCase() === cls.categoria.toUpperCase()
    })
    const productSugs = sugerencias.filter(x => x.suggested && !ruleNames.has(x.description))

    // 1. Regla (la elegida por el clasificador; o la sugerida por el motor).
    if (ruleSugs.length > 0) {
      const chosen = (cls.regla && ruleSugs.find(x => x.description === cls.regla!.name)) || ruleSugs[0]
      const rule = rulesByName.get(chosen.description) ?? cls.regla ?? null
      resolved.push({
        cantidad,
        categoria: rule?.baseCategoria || DEFAULT_CATEGORIA,
        medida: medidaPedida,
        variante: rule?.baseVariante || null,
        precio_unitario: chosen.price,
        faltante: false,
        descripcion: buildSuggestionDesc(
          stripOtherVariants(texto, rule?.baseVariante, vocab),
          chosen.description,
          rule,
          vocab.knownWords,
        ),
        regla_aplicada: chosen.description,
        asumido: null,
      })
      if (!cls.regla && ruleSugs.length > 1) {
        const alt = ruleSugs.filter(x => x !== chosen).map(x => x.description).join(', ')
        notaSupuestos.push(`${etiqueta(cantidad, texto)}: asumí la regla "${chosen.description}"; también aplicaba: ${alt}`)
      }
      total += chosen.price * cantidad
      continue
    }

    const chosen: PriceSuggestion | undefined = productSugs[0]
    const winnerMedida = chosen ? medidaFromText(chosen.basedOn || '') : null
    const winnerProduct = chosen ? productFromBasedOn(chosen.basedOn, productos) : null
    const isExact = !!(chosen && winnerMedida && winnerMedida.s === rds && winnerMedida.l === rdl)

    // 2/3. Medida exacta: una sola variante o varias (asume la primera).
    if (chosen && isExact) {
      const exactVariantes = productSugs
        .filter(x => {
          const md = medidaFromText(x.basedOn || '')
          return md && md.s === rds && md.l === rdl
        })
        .map(x => productFromBasedOn(x.basedOn, productos)?.variante || '')
        .filter(Boolean)
      const variantes = [...new Set(exactVariantes)]
      const variante = winnerProduct?.variante || variantes[0] || null
      const categoria = winnerProduct?.categoria || DEFAULT_CATEGORIA
      resolved.push({
        cantidad,
        categoria,
        medida: medidaPedida,
        variante,
        precio_unitario: chosen.price,
        faltante: false,
        descripcion: describe(categoria, medidaPedida, variante),
        regla_aplicada: null,
        asumido: variantes.length > 1 ? `variante ${variante}` : null,
      })
      if (variantes.length > 1) {
        const otras = variantes.filter(v => v !== variante)
        notaSupuestos.push(`${etiqueta(cantidad, texto)}: hay varias variantes; asumí "${variante}". Otras: ${otras.join(', ')}`)
      }
      total += chosen.price * cantidad
      continue
    }

    // 5. Medida por encima del máximo del catálogo (derivado, sin hardcodear).
    const excedido = bounds && (l > bounds.maxLadoMayor || s > bounds.maxLadoMenor)
    if (excedido) {
      const price = bounds!.maxPrecio
      resolved.push({
        cantidad,
        categoria: cls.categoria,
        medida: medidaPedida,
        variante: null,
        precio_unitario: price,
        faltante: false,
        descripcion: describe(cls.categoria, medidaPedida, null),
        regla_aplicada: null,
        asumido: 'precio provisional (medida fuera de catálogo)',
        aRevisar: true,
      })
      notaSupuestos.push(
        `${etiqueta(cantidad, texto)}: ${medidaPedida} supera el máximo del catálogo; usé un precio provisional (a revisar).`,
      )
      total += price * cantidad
      continue
    }

    // 4. Candidatos por perímetro (sin exacto): el más cercano.
    if (chosen && winnerMedida) {
      const categoria = winnerProduct?.categoria || cls.categoria
      const variante = winnerProduct?.variante || null
      resolved.push({
        cantidad,
        categoria,
        medida: medidaPedida,
        variante,
        precio_unitario: chosen.price,
        faltante: false,
        descripcion: describe(categoria, medidaPedida, variante),
        regla_aplicada: null,
        asumido: `medida de referencia ${winnerMedida.s} x ${winnerMedida.l}`,
      })
      notaSupuestos.push(
        `${etiqueta(cantidad, texto)}: no hay ${rds}x${rdl}; usé la referencia ${winnerMedida.s}x${winnerMedida.l} por perímetro.`,
      )
      total += chosen.price * cantidad
      continue
    }

    // 6. Sin ninguna referencia.
    pushFaltante(cantidad, texto)
  }

  return { items: resolved, total, faltantes, notaSupuestos }
}
