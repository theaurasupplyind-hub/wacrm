// Productos "por atributo": categorías que NO se miden en `AxB` (acrílico con
// `60cc`, circulares con un diámetro `60`, rollo de tela `2 x 5`). El motor de
// precios (`suggestPrice`) solo cotiza medidas `AxB`, así que acá hacemos el
// match determinístico por categoría + medida + variante contra las referencias.
//
// Todo sale de los datos (`refs`); no hay medidas ni variantes hardcodeadas.

import { normalizeText, singularize } from '@/lib/precios'
import type { PrecioReferencia } from '@/lib/precios'

function uniq(values: string[]): string[] {
  return [...new Set(values)]
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function sameCategoria(a: string, b: string): boolean {
  return normalizeText(a) === normalizeText(b)
}

/** ¿El texto menciona la medida `medida`? Soporta `2 x 5`, `60cc`, `30`. */
export function medidaInText(texto: string, medida: string): boolean {
  const nt = normalizeText(texto)
  const nm = normalizeText(medida)
  const dm = nm.match(/(\d+(?:[.,]\d+)?)\s*x\s*(\d+(?:[.,]\d+)?)/)
  if (dm) {
    const a = Math.min(+dm[1].replace(',', '.'), +dm[2].replace(',', '.'))
    const b = Math.max(+dm[1].replace(',', '.'), +dm[2].replace(',', '.'))
    const dt = nt.match(/(\d+(?:[.,]\d+)?)\s*x\s*(\d+(?:[.,]\d+)?)/)
    if (!dt) return false
    const c = Math.min(+dt[1].replace(',', '.'), +dt[2].replace(',', '.'))
    const d = Math.max(+dt[1].replace(',', '.'), +dt[2].replace(',', '.'))
    return c === a && d === b
  }
  // Unidad o número suelto: "60cc", "60 cc", "30".
  const unit = nm.replace(/\s+/g, '')
  const compact = nt.replace(/(\d)\s+([a-z])/g, '$1$2')
  return new RegExp(`(?:^|[^0-9a-z])${escapeRe(unit)}(?:$|[^0-9a-z])`).test(compact)
}

function tokenize(text: string): string[] {
  return normalizeText(text)
    .split(/[^a-z0-9áéíóúñ]+/)
    .filter(t => t.length > 0)
}

function wordPresent(tokens: string[], word: string): boolean {
  const w = normalizeText(word)
  if (!w) return false
  return tokens.some(
    t =>
      t === w ||
      singularize(t) === singularize(w) ||
      (t.length >= 4 && w.length >= 4 && (t.startsWith(w) || w.startsWith(t))),
  )
}

/** ¿El texto menciona la variante `variante` (todas sus palabras)? */
export function varianteInText(texto: string, variante: string): boolean {
  const words = tokenize(variante)
  if (words.length === 0) return false
  const tokens = tokenize(texto)
  return words.every(w => wordPresent(tokens, w))
}

export interface AttrResolution {
  /** Producto único determinado (si el texto alcanza para cotizar). */
  matched: PrecioReferencia | null
  medida: string | null
  variante: string | null
  /** Medidas disponibles en el catálogo para la categoría. */
  medidaOptions: string[]
  /** Variantes disponibles (de la medida detectada, o de toda la categoría). */
  varianteOptions: string[]
}

/** Resuelve un producto por atributo (categoría + medida + variante) del catálogo. */
export function resolveCatalogAttrs(
  texto: string,
  categoria: string,
  refs: PrecioReferencia[],
): AttrResolution {
  const all = refs.filter(r => sameCategoria(r.categoria, categoria))
  const medidas = uniq(all.map(r => r.medida).filter(Boolean))

  const medida = medidas.find(m => medidaInText(texto, m)) ?? null
  let pool = medida ? all.filter(r => r.medida === medida) : all

  const variantesDeMedida = uniq(pool.map(r => r.variante).filter(Boolean))
  const variante = variantesDeMedida.find(v => varianteInText(texto, v)) ?? null
  if (variante) pool = pool.filter(r => r.variante === variante)

  const varianteOptions = medida
    ? uniq(all.filter(r => r.medida === medida).map(r => r.variante).filter(Boolean))
    : uniq(all.map(r => r.variante).filter(Boolean))

  return {
    matched: pool.length === 1 ? pool[0] : null,
    medida,
    variante,
    medidaOptions: medidas,
    varianteOptions,
  }
}

/** ¿La categoría se mide en `AxB`? (bastidor y derivados) */
export function isDimensionCategoria(categoria: string, refs: PrecioReferencia[]): boolean {
  const medidas = refs.filter(r => sameCategoria(r.categoria, categoria)).map(r => r.medida)
  if (medidas.length === 0) return false
  return medidas.every(m => /\d\s*x\s*\d/i.test(normalizeText(m)))
}
