// Motor de precios. Port fiel de galv2-tauri/src/lib/utils/precios.ts.
// Solo se porta lo que usa el flujo de pedidos: `suggestPrice` y sus helpers.
// Se omiten `evaluateRules` (debug del modal de reglas) y `smartProductSearch`.

import type {
  CatalogBounds,
  ParsedQuery,
  PrecioReferencia,
  PricingRule,
  PriceSuggestion,
  Producto,
} from './types'

// ── Normalización (acentos, separadores, espacios) ──

export function normalizeText(text: string): string {
  let t = text.toLowerCase().trim()
  t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  // Normalizar primero las medidas triples evita que "67 x 67 x 3"
  // termine convertido en "67x67 x 3".
  t = t.replace(
    /(\d+(?:[.,]\d+)?)\s*[xX*×]\s*(\d+(?:[.,]\d+)?)\s*[xX*×]\s*(\d+(?:[.,]\d+)?)/g,
    '$1x$2x$3',
  )
  t = t.replace(/(\d+(?:[.,]\d+)?)\s*[xX*×]\s*(\d+(?:[.,]\d+)?)/g, '$1x$2')
  t = t.replace(/\s+/g, ' ').trim()
  return t
}

export function getBaseAndDims(text: string): { base: string; dims: Set<string> } {
  const parsed = parseQuery(text)
  return { base: parsed.base, dims: new Set(parsed.dims) }
}

// ── Parseo de query con grosor (triple dim: 40x50x5) ──

export function parseQuery(query: string): ParsedQuery {
  const norm = normalizeText(query)
  const tripleRegex = /(\d+(?:[.,]\d+)?)\s*x\s*(\d+(?:[.,]\d+)?)(?:\s*x\s*(\d+(?:[.,]\d+)?))?/
  const m = norm.match(tripleRegex)
  const dims: string[] = []
  let grosor: number | null = null
  if (m) {
    const d1 = parseFloat(m[1].replace(',', '.'))
    const d2 = parseFloat(m[2].replace(',', '.'))
    dims.push(`${Math.min(d1, d2)}x${Math.max(d1, d2)}`)
    if (m[3] !== undefined) {
      grosor = parseFloat(m[3].replace(',', '.'))
    }
  }
  const base = dims.length > 0 ? norm.replace(tripleRegex, '').trim() : norm
  const tokens = base.split(/\s+/).filter(t => t.length > 0)
  return { tokens, dims, base, grosor }
}

// ── Singularización simple ──
// "pinturas"→"pintura", "tapacantos"→"tapacanto", "marcos"→"marco".

export function singularize(word: string): string {
  const w = (word || '').toLowerCase().trim()
  if (w.length <= 3 || !w.endsWith('s')) return w
  if (w.endsWith('es') && w.length > 4) {
    const prev = w.charAt(w.length - 3)
    if (!'aeiou'.includes(prev)) return w.slice(0, -2)
  }
  return w.slice(0, -1)
}

function capFirst(text: string): string {
  if (!text) return text
  return text.charAt(0).toUpperCase() + text.slice(1)
}

// ── Matching de reglas por tokens (normalizado, no-estricto) ──
// Niveles: exacto (100) > singular/pegado (90) > frase contenida (80) >
// prefijo >=2 letras en ambos sentidos (60-79, más largo = más score).

export function ruleMatchScore(parsed: ParsedQuery, rule: PricingRule): { score: number; matched: string | null } {
  const base = parsed.base || ''
  const baseNoSpace = base.replace(/\s+/g, '')
  const tokens = parsed.tokens || []
  const triggers: string[] = [...(rule.matchTokens || []), rule.name || ''].filter(Boolean)

  let best = 0
  let bestRaw: string | null = null
  const consider = (score: number, raw: string) => {
    if (score > best) {
      best = score
      bestRaw = raw
    }
  }

  for (const raw of triggers) {
    const mt = normalizeText(String(raw || ''))
    if (!mt) continue
    const mtNoSpace = mt.replace(/\s+/g, '')
    const mtSing = singularize(mt)
    const mtWords = mt.split(/\s+/).filter(Boolean)

    // Exacto frase / token
    if (base === mt) {
      consider(100, String(raw))
      continue
    }
    if (tokens.includes(mt)) {
      consider(100, String(raw))
      continue
    }
    // Exacto singular / pegado
    if (singularize(base) === mtSing && base) {
      consider(90, String(raw))
      continue
    }
    if (baseNoSpace && mtNoSpace && baseNoSpace === mtNoSpace) {
      consider(90, String(raw))
      continue
    }
    // Frase contenida (multi-palabra)
    if (mt.includes(' ')) {
      if (base.includes(mt)) {
        consider(80, String(raw))
        continue
      }
      if (mtNoSpace.length >= 3 && baseNoSpace.includes(mtNoSpace)) {
        consider(78, String(raw))
        continue
      }
      // Prefijo de frase: "fibro" → "fibro facil", "sin" → "sin tela"
      if (base.length >= 2 && mt.startsWith(base)) {
        consider(60 + Math.min(19, base.length), String(raw))
        continue
      }
      if (mt.length >= 2 && base.startsWith(mt)) {
        consider(60 + Math.min(19, mt.length), String(raw))
        continue
      }
    } else {
      // Glued: "sintela" ⇔ "sin tela" / "sin" en "sintela"
      if (mtNoSpace.length >= 2 && baseNoSpace.includes(mtNoSpace) && baseNoSpace !== mtNoSpace) {
        consider(mtNoSpace.length <= 3 ? 70 : 78, String(raw))
      }
    }

    // Por palabra: exacto, singular y prefijo en ambos sentidos
    for (const qt of tokens) {
      const qtSing = singularize(qt)
      for (const mw of mtWords) {
        const mwSing = singularize(mw)
        if (qt === mw) {
          consider(100, String(raw))
          break
        }
        if (qtSing === mwSing) {
          consider(90, String(raw))
          break
        }
        // Prefijo query→trigger: "pi"→"pintura", "ta"→"tapacantos", "embas"→"embastado"
        if (qt.length >= 2 && mw.startsWith(qt)) {
          consider(60 + Math.min(19, qt.length), String(raw))
        }
        // Inicial con medidas ("90x87 p"→"pintura"): solo si hay dims.
        else if (qt.length === 1 && parsed.dims.length > 0 && mw.startsWith(qt)) {
          consider(55, String(raw))
        }
        // Prefijo trigger→query: "pinturas" vs token "pintura", "sintela" vs "sin"
        else if (mw.length >= 2 && qt.startsWith(mw)) {
          consider(60 + Math.min(19, mw.length), String(raw))
        }
      }
    }
  }

  if (best > 0 && bestRaw) return { score: best, matched: bestRaw }

  // Una query triple ("67x67x3") ya identifica un producto con grosor:
  // pueden aplicar reglas que dependen explícitamente del grosor.
  if (parsed.grosor !== null && rule.conditions?.some(c => c.field === 'grosor')) {
    return { score: 50, matched: 'grosor' }
  }
  return { score: 0, matched: null }
}

export function ruleMatchesQuery(parsed: ParsedQuery, rule: PricingRule): string | null {
  return ruleMatchScore(parsed, rule).matched
}

// ── Nombre final de la sugerencia (genérico, sin hardcodear productos) ──

export function buildSuggestionDesc(
  userQuery: string,
  ruleName: string,
  rule?: Pick<PricingRule, 'baseCategoria' | 'baseVariante' | 'matchTokens'> | null,
): string {
  const dimsRe = /\d+(?:[.,]\d+)?\s*[xX×]\s*\d+(?:[.,]\d+)?(?:\s*[xX×]\s*\d+(?:[.,]\d+)?)?/
  const userDims = (userQuery || '').match(dimsRe)
  if (!userDims) return ruleName || userQuery
  const dimsText = userDims[0].replace(/\s+/g, ' ').trim()

  const triggers: string[] = [ruleName, ...((rule?.matchTokens as string[]) || [])].filter(Boolean)
  // Quitar medidas primero
  let remainder = (userQuery || '')
    .replace(new RegExp(dimsRe.source, 'g'), ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // Quitar menciones completas de los triggers (frases largas primero, con \b)
  const sorted = [...triggers].sort((a, b) => String(b).length - String(a).length)
  for (const t of sorted) {
    const norm = normalizeText(String(t))
    if (!norm) continue
    const esc = String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    try {
      remainder = remainder.replace(new RegExp(`\\b${esc}\\b`, 'gi'), ' ')
    } catch {
      remainder = remainder.replace(new RegExp(esc, 'gi'), ' ')
    }
    // También quitar versión singular/plural simple del trigger
    const sing = singularize(norm)
    if (sing && sing !== norm) {
      const escS = sing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      try {
        remainder = remainder.replace(new RegExp(`\\b${escS}\\b`, 'gi'), ' ')
      } catch {
        /* noop */
      }
    }
  }
  remainder = remainder.replace(/\s+/g, ' ').trim()

  const ruleNorm = normalizeText(ruleName)
  const ruleSing = singularize(ruleNorm)
  const remNorm = normalizeText(remainder)
  const remSing = singularize(remNorm)

  // ¿El resto es la misma idea (exacto, plural o abreviatura/prefijo)?
  const hasDims = !!userDims
  let consumed = remNorm.length === 0
  if (!consumed) {
    if (remNorm === ruleNorm || remSing === ruleSing) consumed = true
    else if (
      (remNorm.length >= 2 || (remNorm.length === 1 && hasDims)) &&
      (ruleNorm.startsWith(remNorm) || ruleSing.startsWith(remNorm))
    ) {
      consumed = true
    } else if (ruleNorm.length >= 2 && (remNorm.startsWith(ruleNorm) || remNorm.startsWith(ruleSing))) {
      consumed = true
    } else {
      // Alias: el resto es otro token de la misma regla
      const aliasHit = (rule?.matchTokens || []).some(t => {
        const tn = normalizeText(String(t))
        return (
          tn &&
          (tn === remNorm ||
            singularize(tn) === remSing ||
            ((remNorm.length >= 2 || (remNorm.length === 1 && hasDims)) && tn.startsWith(remNorm)))
        )
      })
      if (aliasHit) consumed = true
      // Resto es primera palabra de un nombre multi-palabra ("sin"→"sin tela")
      if (!consumed && ruleNorm.includes(' ')) {
        const first = ruleNorm.split(/\s+/)[0]
        if (
          remNorm === first ||
          singularize(first) === remSing ||
          ((remNorm.length >= 2 || (remNorm.length === 1 && hasDims)) && first.startsWith(remNorm))
        ) {
          consumed = true
        }
      }
    }
  }

  if (consumed) {
    const varNorm = normalizeText(String(rule?.baseVariante || ''))
    const isVarianteRule = varNorm && (ruleNorm === varNorm || ruleSing === singularize(varNorm))
    if (isVarianteRule) {
      const cat = (rule?.baseCategoria || 'Bastidor').toLowerCase()
      const catCap = capFirst(cat)
      return `${catCap} ${dimsText} ${ruleName}`.replace(/\s+/g, ' ').trim()
    }
    // Producto: preferir la forma del usuario si solo difiere en plural.
    let display = ruleName
    if (remainder && remSing === ruleSing) display = capFirst(remainder.toLowerCase())
    else display = capFirst(ruleSing)
    return `${display} ${dimsText}`.replace(/\s+/g, ' ').trim()
  }

  // Concepto distinto al de la regla: conservar prefijo ("Marco dorado 45x32 Tapacanto")
  const prefix = capFirst(remainder)
  return `${prefix} ${dimsText} ${ruleName}`.replace(/\s+/g, ' ').trim()
}

// ── Conversión desde PrecioReferencia ──

export function refsToProductos(refs: PrecioReferencia[]): Producto[] {
  return refs.map(r => ({
    id: '',
    descripcion: `${r.categoria.charAt(0).toUpperCase() + r.categoria.slice(1).toLowerCase()} ${r.medida} ${r.variante}`.trim(),
    precio_unitario: r.precio,
    categoria: r.categoria,
    medida: r.medida,
    variante: r.variante,
    stock: 0,
  }))
}

// ── Redondeo de precios (half-down para .5; negativo = hacia arriba) ──

function roundPrice(price: number, roundTo: number): number {
  const step = Math.abs(roundTo)
  if (step <= 0) return price
  if (roundTo < 0) return Math.ceil(price / step) * step
  const half = step / 2
  const remainder = price % step
  if (remainder > half) {
    return Math.ceil(price / step) * step
  } else {
    return Math.floor(price / step) * step
  }
}

// ── Redondeo fijo: 0-3 piso, 4-9 techo ──

export function roundDim(val: number): number {
  const remainder = val % 10
  if (remainder <= 3) {
    return Math.floor(val / 10) * 10
  } else {
    return Math.ceil(val / 10) * 10
  }
}

// ── Medidas de una referencia (solo si tiene formato AxB) ──

function measureDims(medida: string): { s: number; l: number } | null {
  const norm = normalizeText(medida)
  const p = norm.match(/(\d+)x(\d+)/)
  if (!p) return null
  const a = parseFloat(p[1])
  const b = parseFloat(p[2])
  return { s: Math.min(a, b), l: Math.max(a, b) }
}

// ── Límites del catálogo cargado (sin valores hardcodeados) ──

export function catalogBounds(refs: PrecioReferencia[]): CatalogBounds | null {
  let maxLadoMayor = 0
  let maxLadoMenor = 0
  let maxPerimetro = 0
  let maxPrecio = 0
  let hasDims = false
  for (const r of refs) {
    if (r.precio > maxPrecio) maxPrecio = r.precio
    const md = measureDims(r.medida)
    if (!md) continue
    hasDims = true
    const perim = 2 * (md.s + md.l)
    if (md.l > maxLadoMayor) maxLadoMayor = md.l
    if (md.s > maxLadoMenor) maxLadoMenor = md.s
    if (perim > maxPerimetro) maxPerimetro = perim
  }
  if (!hasDims) return null
  return { maxLadoMayor, maxLadoMenor, maxPerimetro, maxPrecio }
}

// ── Cálculo de precio estimado por perímetro ──

function calcPriceByPerimeter(
  dimSmall: number,
  dimLarge: number,
  pool: Array<{ product: Producto; dimSmall: number; dimLarge: number }>,
): number | null {
  const valid = pool.filter(pd => pd.product.precio_unitario > 0)
  if (valid.length === 0) return null

  const queryPerimeter = 2 * (dimSmall + dimLarge)

  const closest = [...valid]
    .map(pd => ({
      ...pd,
      diff: Math.abs(2 * (pd.dimSmall + pd.dimLarge) - queryPerimeter),
    }))
    .sort((a, b) => a.diff - b.diff)
    .slice(0, 5)

  let total = 0
  for (const pd of closest) {
    total += pd.product.precio_unitario / (2 * (pd.dimSmall + pd.dimLarge))
  }

  const rawPrice = Math.round((total / closest.length) * queryPerimeter)

  const remainder = rawPrice % 1000
  if (remainder >= 400) {
    return Math.ceil(rawPrice / 1000) * 1000
  } else {
    return Math.floor(rawPrice / 1000) * 1000
  }
}

// ── Sugerencia de precio para medidas personalizadas ──

export function suggestPrice(query: string, products: Producto[], rules?: PricingRule[]): PriceSuggestion[] {
  const { base, dims } = getBaseAndDims(query)
  if (dims.size === 0) return []

  const dimPair = [...dims][0]
  const [dimSmall, dimLarge] = dimPair.split('x').map(Number)

  let result: PriceSuggestion[] = []

  // ── Evaluar reglas (solo las que matchean el query) ──
  if (rules && rules.length > 0) {
    const parsed = parseQuery(query)
    for (const rule of rules) {
      if (!rule.enabled) continue
      if (!ruleMatchesQuery(parsed, rule)) continue

      const catUpper = rule.baseCategoria.toUpperCase()
      const varUpper = rule.baseVariante.toUpperCase()
      const refCandidates = products.filter(
        p => p.categoria.toUpperCase() === catUpper && p.variante.toUpperCase() === varUpper,
      )
      if (refCandidates.length === 0) continue

      const rds = roundDim(dimSmall)
      const rdl = roundDim(dimLarge)

      let baseProduct: Producto | null = null
      const exact = refCandidates.find(p => {
        const md = measureDims(p.medida)
        return md && md.s === rds && md.l === rdl
      })
      if (exact) {
        baseProduct = exact
      } else {
        const targetPerim = 2 * (rds + rdl)
        let best: Producto | null = null
        let bestDiff = Infinity
        for (const p of refCandidates) {
          const md = measureDims(p.medida)
          if (!md) continue
          const diff = Math.abs(2 * (md.s + md.l) - targetPerim)
          if (diff < bestDiff) {
            bestDiff = diff
            best = p
          }
        }
        baseProduct = best
      }

      if (!baseProduct) continue

      let price = baseProduct.precio_unitario

      if (rule.operation === 'percentage') {
        price += Math.round((price * rule.operationValue) / 100)
      } else if (rule.operation === 'fixed') {
        price += rule.operationValue
      } else if (rule.operation === 'override') {
        price = rule.operationValue
      }

      for (const cond of rule.conditions) {
        let actual: number | null = null
        if (cond.field === 'grosor') actual = parsed.grosor
        else if (cond.field === 'lado_mayor') actual = Math.max(dimSmall, dimLarge)
        else if (cond.field === 'lado_menor') actual = Math.min(dimSmall, dimLarge)
        let met = false
        if (actual !== null) {
          if (cond.operator === '>') met = actual > cond.value
          else if (cond.operator === '>=') met = actual >= cond.value
          else if (cond.operator === '<') met = actual < cond.value
          else if (cond.operator === '<=') met = actual <= cond.value
          else if (cond.operator === '==') met = actual === cond.value
        }
        if (met) {
          if (cond.adjustmentType === 'percentage') {
            price += Math.round((price * cond.adjustmentValue) / 100)
          } else {
            price += cond.adjustmentValue
          }
        }
      }

      if (rule.rounding !== 0 && price > 0) {
        price = roundPrice(price, rule.rounding)
      }

      result.push({
        description: rule.name,
        price,
        basedOn: `${rule.name} → ${baseProduct.variante || baseProduct.categoria} ${baseProduct.medida}`,
        suggested: true,
      })
    }
  }

  const productsWithDims: Array<{
    product: Producto
    dimSmall: number
    dimLarge: number
  }> = []

  for (const p of products) {
    const { base: pBase, dims: pDims } = getBaseAndDims(p.descripcion)
    if (pDims.size === 0) continue
    if (base && !pBase.includes(base) && !base.includes(pBase)) continue
    const pd = [...pDims][0]
    const [ps, pl] = pd.split('x').map(Number)
    productsWithDims.push({ product: p, dimSmall: ps, dimLarge: pl })
  }

  if (productsWithDims.length === 0) {
    if (result.length > 0) return result
    return [
      {
        description: query,
        price: 0,
        suggested: false,
        hint: base
          ? `Sin referencia: no hay precios guardados para "${base}" con medidas`
          : 'Sin referencia: categoría no encontrada en precios guardados',
      },
    ]
  }

  const roundedSmall = roundDim(dimSmall)
  const roundedLarge = roundDim(dimLarge)

  const slPriority = (desc: string): boolean => /(?:^|[ (])[SL][a-záéíóúñ]{2,}/i.test(desc)

  // Token relevance: word-start (do->doble) vale más que substring.
  const tokenScore = (queryBase: string, desc: string): number => {
    const q = normalizeText(queryBase).trim()
    if (!q) return 0
    const qTokens = q.split(/\s+/).filter(t => t.length >= 2)
    if (qTokens.length === 0) return 0
    const dNorm = normalizeText(desc)
    const dWords = dNorm.split(/\s+/)
    let score = 0
    for (const qt of qTokens) {
      if (dWords.some(w => w.startsWith(qt))) score += 10
      else if (dWords.some(w => w.includes(qt))) score += 5
      else if (dNorm.includes(qt)) score += 1
    }
    return score
  }

  const exactMatches = productsWithDims
    .filter(pd => pd.dimSmall === roundedSmall && pd.dimLarge === roundedLarge)
    .sort((a, b) => {
      const sa = tokenScore(base, a.product.descripcion)
      const sb = tokenScore(base, b.product.descripcion)
      if (sa !== sb) return sb - sa
      const aPrio = slPriority(a.product.descripcion) ? 0 : 1
      const bPrio = slPriority(b.product.descripcion) ? 0 : 1
      return aPrio - bPrio
    })

  if (exactMatches.length > 0) {
    result = [
      ...exactMatches.map(pd => ({
        description: query,
        price: pd.product.precio_unitario,
        basedOn: pd.product.descripcion,
        suggested: true,
      })),
      ...result,
    ]
  } else {
    const targetPerimeter = 2 * (roundedSmall + roundedLarge)
    const sorted = [...productsWithDims].sort((a, b) => {
      const sa = tokenScore(base, a.product.descripcion)
      const sb = tokenScore(base, b.product.descripcion)
      if (sa !== sb) return sb - sa
      const aPrio = slPriority(a.product.descripcion) ? 0 : 1
      const bPrio = slPriority(b.product.descripcion) ? 0 : 1
      if (aPrio !== bPrio) return aPrio - bPrio
      const da = Math.abs(2 * (a.dimSmall + a.dimLarge) - targetPerimeter)
      const db = Math.abs(2 * (b.dimSmall + b.dimLarge) - targetPerimeter)
      return da - db
    })

    result = [
      ...sorted.slice(0, 8).map(pd => ({
        description: query,
        price: pd.product.precio_unitario,
        basedOn: pd.product.descripcion,
        suggested: true,
      })),
      ...result,
    ]
  }

  const estimated = calcPriceByPerimeter(dimSmall, dimLarge, productsWithDims)
  if (estimated !== null) {
    result.push({
      description: query,
      price: estimated,
      suggested: false,
      estimated: true,
    })
  }

  if (result.length === 0) {
    return [
      {
        description: query,
        price: 0,
        suggested: false,
        hint: `Sin coincidencia: ${roundedSmall}x${roundedLarge} no tiene precio de referencia y no se pudo estimar por perímetro`,
      },
    ]
  }

  return result
}
