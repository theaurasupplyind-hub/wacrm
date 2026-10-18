// Clasificador determinístico de ítems de pedido contra el Vocabulario del
// catálogo (categorías + variantes + reglas, derivado de datos, sin hardcodear
// productos). Reemplaza el matching por substring del motor como *decisión* de
// candidatos: entiende unidades/relleno/orden/sinónimos simples y deja el motor
// para la matemática de precios.

import { normalizeText, parseQuery, singularize } from '@/lib/precios'
import type { PrecioReferencia, PricingRule } from '@/lib/precios'
import type { OrderGlossaryEntry } from './glossary'
import type { ParsedOrderItem } from './types'
import { DEFAULT_CATEGORIA } from '@/lib/catalog/defaults'

export interface UnknownTerm {
  term: string
  itemIndex: number
}

export interface CatalogVocab {
  categories: string[]
  categoryByWord: Map<string, string>
  variants: string[]
  variantWords: Map<string, string[]>
  rules: PricingRule[]
  ruleWords: Map<string, string[]>
  /** Todas las palabras conocidas (categorías/variantes/reglas), normalizadas. */
  knownWords: string[]
}

export interface ItemClassification {
  medida: { s: number; l: number } | null
  grosor: number | null
  categoria: string
  variante: string | null
  regla: PricingRule | null
  unknownTerms: string[]
}

// Palabras funcionales/unidades que nunca son términos del catálogo.
// Ojo: NO incluir "sin"/"con" — son parte de variantes ("Sin Tela").
const STOPWORDS = new Set([
  'de', 'del', 'con', 'para', 'y', 'e', 'a', 'el', 'la', 'los', 'las',
  'un', 'una', 'unos', 'unas', 'en', 'por', 'cm', 'cms', 'mm', 'mts', 'm',
  'grosor', 'medida', 'tipo', 'color', 'aprox', 'centimetros',
])

function wordList(text: string, minLen = 2): string[] {
  return normalizeText(text)
    .split(/\s+/)
    .map(w => w.replace(/[^a-z0-9áéíóúñ]/g, ''))
    .filter(w => w.length >= minLen && !/^\d/.test(w))
}

/** ¿`token` corresponde a `word`? (exacto, singular, prefijo o raíz común). */
export function tokenMatchesWord(token: string, word: string): boolean {
  if (token === word) return true
  if (singularize(token) === singularize(word)) return true
  if (token.length >= 4 && word.length >= 4 && (token.startsWith(word) || word.startsWith(token))) return true
  // raíz común larga ("embastame" ⇔ "embastar")
  const min = Math.min(token.length, word.length)
  let i = 0
  while (i < min && token[i] === word[i]) i++
  return i >= 5
}

export function buildKnownVocab(refs: PrecioReferencia[], rules: PricingRule[]): CatalogVocab {
  const categories = [...new Set(refs.map(r => r.categoria))]

  // Variantes primero: sus palabras no cuentan como palabra "de categoría"
  // (ej. "tela" de "Sin Tela" no debe mapear a la categoría "ROLLO DE TELA").
  const variantWords = new Map<string, string[]>()
  const variants = [
    ...new Set(refs.filter(r => r.categoria.toUpperCase() === DEFAULT_CATEGORIA).map(r => r.variante)),
  ].filter(Boolean)
  for (const v of variants) {
    variantWords.set(v, wordList(v, 2))
  }
  const variantWordSet = new Set<string>()
  for (const ws of variantWords.values()) for (const w of ws) variantWordSet.add(w)

  const categoryByWord = new Map<string, string>()
  for (const cat of categories) {
    for (const w of wordList(cat, 3)) {
      if (STOPWORDS.has(w) || variantWordSet.has(w)) continue
      categoryByWord.set(w, cat)
      // También el singular, para que "circular" matchee "CIRCULARES".
      const sing = singularize(w)
      if (sing && sing !== w) categoryByWord.set(sing, cat)
    }
  }

  const ruleWords = new Map<string, string[]>()
  for (const rule of rules) {
    const words = new Set<string>()
    for (const w of wordList(rule.name, 2)) words.add(w)
    for (const t of rule.matchTokens) for (const w of wordList(t, 2)) words.add(w)
    ruleWords.set(rule.name, [...words])
  }

  const known = new Set<string>()
  for (const w of categoryByWord.keys()) known.add(w)
  for (const ws of variantWords.values()) for (const w of ws) known.add(w)
  for (const ws of ruleWords.values()) for (const w of ws) known.add(w)

  return {
    categories,
    categoryByWord,
    variants,
    variantWords,
    rules,
    ruleWords,
    knownWords: [...known],
  }
}

function tokenize(text: string): string[] {
  return normalizeText(text)
    .split(/[^a-z0-9áéíóúñ]+/)
    .filter(t => t.length >= 3 && !/\d/.test(t) && !STOPWORDS.has(t))
}

function hasToken(tokens: string[], word: string): boolean {
  return tokens.some(t => tokenMatchesWord(t, word))
}

/** Clasifica el texto de un ítem al vocabulario del catálogo. */
export function classifyItem(
  texto: string,
  vocab: CatalogVocab,
  glossary: OrderGlossaryEntry[] = [],
): ItemClassification {
  const raw = (texto || '').trim()
  const parsed = parseQuery(raw)
  let medida: { s: number; l: number } | null = null
  if (parsed.dims.length > 0) {
    const [a, b] = parsed.dims[0].split('x').map(Number)
    if (Number.isFinite(a) && Number.isFinite(b)) medida = { s: Math.min(a, b), l: Math.max(a, b) }
  }
  const grosor = parsed.grosor

  const tokens = tokenize(raw)

  // Categoría (default BASTIDOR como en el flujo).
  let categoria = DEFAULT_CATEGORIA
  for (const t of tokens) {
    const c = vocab.categoryByWord.get(t) ?? vocab.categoryByWord.get(singularize(t))
    if (c) {
      categoria = c
      break
    }
  }

  // Variante: todas sus palabras presentes. Las variantes del catálogo son de
  // BASTIDOR, así que solo aplican a esa categoría (evita que "rollo de tela"
  // + "sin tela" del contexto se vuelva un BASTIDOR Sin Tela). Si el texto
  // menciona varias, gana la ÚLTIMA mencionada (así "… sin tela" corrige un
  // "lienzo profesional" anterior).
  const variantMatches: { variant: string; words: string[]; lastPos: number }[] = []
  if (categoria === DEFAULT_CATEGORIA) {
    for (const [variant, words] of vocab.variantWords) {
      if (words.length === 0 || !words.every(w => hasToken(tokens, w))) continue
      let lastPos = -1
      tokens.forEach((t, i) => {
        if (words.some(w => tokenMatchesWord(t, w))) lastPos = i
      })
      variantMatches.push({ variant, words, lastPos })
    }
    variantMatches.sort((a, b) => b.lastPos - a.lastPos || b.words.length - a.words.length)
  }
  const variante = variantMatches[0]?.variant ?? null

  // Regla: la de mayor cantidad de palabras matcheadas. Las reglas del catálogo
  // se basan en BASTIDOR, así que no aplican a otras categorías (evita que
  // "rollo de tela … sin tela" tome la regla Sin Tela).
  let regla: PricingRule | null = null
  let bestScore = 0
  for (const rule of vocab.rules) {
    if (rule.baseCategoria && normalizeText(rule.baseCategoria) !== normalizeText(categoria)) continue
    const words = vocab.ruleWords.get(rule.name) ?? []
    let score = 0
    for (const w of words) if (hasToken(tokens, w)) score++
    if (score > 0 && score > bestScore) {
      bestScore = score
      regla = rule
    }
  }

  // Términos desconocidos (no categoría/variante/regla/glosario).
  const glossaryWords = new Set<string>()
  for (const g of glossary) for (const w of wordList(g.termNorm, 2)) glossaryWords.add(w)
  const unknownTerms: string[] = []
  const seen = new Set<string>()
  for (const t of tokens) {
    if (seen.has(t)) continue
    seen.add(t)
    if (glossaryWords.has(t)) continue
    const known =
      vocab.knownWords.some(w => tokenMatchesWord(t, w)) ||
      [...glossaryWords].some(w => tokenMatchesWord(t, w))
    if (!known) unknownTerms.push(t)
  }

  return { medida, grosor, categoria, variante, regla, unknownTerms }
}

/** Detecta términos desconocidos en una lista de ítems (para el glosario). */
export function detectUnknownTerms(
  items: ParsedOrderItem[],
  vocab: CatalogVocab,
  glossary: OrderGlossaryEntry[] = [],
): UnknownTerm[] {
  const out: UnknownTerm[] = []
  const seen = new Set<string>()
  items.forEach((it, itemIndex) => {
    for (const term of classifyItem(it.texto, vocab, glossary).unknownTerms) {
      if (seen.has(term)) continue
      seen.add(term)
      out.push({ term, itemIndex })
    }
  })
  return out
}

/**
 * Quita del texto las palabras de variantes BASTIDOR distintas de `keep`. Sirve
 * para que una corrección ("… sin tela") no arrastre la variante anterior
 * ("lienzo profesional") en la descripción del producto.
 */
export function stripOtherVariants(
  texto: string,
  keep: string | null | undefined,
  vocab: CatalogVocab,
): string {
  const keepKey = normalizeText(keep || '')
  const dropWords = new Set<string>()
  for (const [variant, words] of vocab.variantWords) {
    if (normalizeText(variant) === keepKey) continue
    for (const w of words) dropWords.add(w)
  }
  if (dropWords.size === 0) return texto
  const dropList = [...dropWords]
  return (texto || '')
    .split(/\s+/)
    .filter(tok => {
      const t = normalizeText(tok).replace(/[^a-z0-9áéíóúñ]/g, '')
      if (!t || /\d/.test(t)) return true
      return !dropList.some(w => tokenMatchesWord(t, w))
    })
    .join(' ')
}
