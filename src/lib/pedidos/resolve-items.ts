// Resolución determinística de precios por ítem. "Asume y corrige": nunca
// bloquea con preguntas, elige el mejor candidato y anota los supuestos.
// Usa el motor portado en `@/lib/precios`.

import { suggestPrice, refsToProductos, catalogBounds, buildSuggestionDesc, roundDim, parseQuery, ruleMatchScore } from '@/lib/precios'
import type { PrecioReferencia, PricingRule, Producto, PriceSuggestion } from '@/lib/precios'
import type { ParsedOrderItem, PedidoItem } from './types'

const DEFAULT_CATEGORIA = 'BASTIDOR'

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

export function resolveItems(args: {
  items: ParsedOrderItem[]
  refs: PrecioReferencia[]
  rules: PricingRule[]
}): ResolveResult {
  const { items, refs, rules } = args
  const productos = refsToProductos(refs)
  const bounds = catalogBounds(refs)
  const rulesByName = new Map(rules.map(r => [r.name, r]))
  const ruleNames = new Set(rules.map(r => r.name))

  const resolved: PedidoItem[] = []
  const notaSupuestos: string[] = []
  const faltantes: string[] = []
  let total = 0

  const pushFaltante = (cantidad: number, texto: string) => {
    const item: PedidoItem = {
      cantidad,
      categoria: DEFAULT_CATEGORIA,
      medida: null,
      variante: null,
      precio_unitario: null,
      faltante: true,
      descripcion: texto || '(sin descripción)',
      regla_aplicada: null,
      asumido: null,
    }
    resolved.push(item)
    faltantes.push(etiqueta(cantidad, texto || '(sin descripción)'))
  }

  for (const raw of items) {
    const cantidad = Number.isFinite(raw.cantidad) && raw.cantidad > 0 ? Math.floor(raw.cantidad) : 1
    const texto = (raw.texto || '').trim()
    const dims = medidaFromText(texto)

    if (!texto || !dims) {
      pushFaltante(cantidad, texto)
      continue
    }

    const rds = roundDim(dims.s)
    const rdl = roundDim(dims.l)
    const medidaPedida = `${dims.s} x ${dims.l}`

    const sugerencias = suggestPrice(texto, productos, rules)
    const ruleSugs = sugerencias.filter(s => s.suggested && ruleNames.has(s.description))
    const productSugs = sugerencias.filter(s => s.suggested && !ruleNames.has(s.description))

    // 1. Regla matchea → precio de regla (primera, orden estable).
    if (ruleSugs.length > 0) {
      // Con varias reglas, elegir la de MAYOR score de match (no la primera por
      // orden): el motor agrega reglas espurias por el fallback de grosor.
      const parsed = parseQuery(texto)
      const ranked = ruleSugs
        .map(s => {
          const r = rulesByName.get(s.description) ?? null
          return { s, rule: r, score: r ? ruleMatchScore(parsed, r).score : 0 }
        })
        .sort((a, b) => b.score - a.score)
      const chosen = ranked[0].s
      const rule = ranked[0].rule
      resolved.push({
        cantidad,
        categoria: rule?.baseCategoria || DEFAULT_CATEGORIA,
        medida: medidaPedida,
        variante: rule?.baseVariante || null,
        precio_unitario: chosen.price,
        faltante: false,
        descripcion: buildSuggestionDesc(texto, chosen.description, rule),
        regla_aplicada: chosen.description,
        asumido: null,
      })
      if (ranked.length > 1) {
        const alt = ranked.slice(1).map(r => r.s.description).join(', ')
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
        .filter(s => {
          const md = medidaFromText(s.basedOn || '')
          return md && md.s === rds && md.l === rdl
        })
        .map(s => productFromBasedOn(s.basedOn, productos)?.variante || '')
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
    const excedido = bounds && (dims.l > bounds.maxLadoMayor || dims.s > bounds.maxLadoMenor)
    if (excedido) {
      const price = bounds!.maxPrecio
      resolved.push({
        cantidad,
        categoria: DEFAULT_CATEGORIA,
        medida: medidaPedida,
        variante: null,
        precio_unitario: price,
        faltante: false,
        descripcion: describe(DEFAULT_CATEGORIA, medidaPedida, null),
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
      const categoria = winnerProduct?.categoria || DEFAULT_CATEGORIA
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
