import type { ParsedExpense, PaymentSplit } from './types'

const EXPENSE_INTENT_KEYWORDS = [
  'gaste', 'gasté', 'gasto',
  'pague', 'pagué', 'pago',
  'compre', 'compré', 'compra',
  'paguemos', 'gastamos', 'compramos',
  'deposité', 'deposite', 'deposito',
  'transferí', 'transferi', 'transfiera',
  'costo', 'costó', 'cuesto',
  'debemos', 'adeudamos', 'debo', 'deuda',
  'pagamos', 'pagar', 'puse', 'puso',
]

const PAYMENT_METHODS: Record<string, string> = {
  efectivo: 'efectivo',
  transferencia: 'transferencia',
  transferi: 'transferencia',
  transferí: 'transferencia',
  debito: 'debito',
  débito: 'debito',
  credito: 'credito',
  crédito: 'credito',
  'mercado pago': 'mercado_pago',
  mp: 'mercado_pago',
  qr: 'qr',
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s.,]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Palabras que indican un desembolso y suelen preceder al monto.
// Se usan tanto sobre texto normalizado (detección) como sobre el texto crudo
// (regex de anclaje), por eso se incluyen ambas formas (acentuada y no).
const MONEY_ANCHOR_WORDS = [
  'pagué', 'pague', 'pagó', 'pago', 'pagan', 'pagamos', 'pagar', 'pagaste', 'paguemos',
  'gasté', 'gaste', 'gastó', 'gasto', 'gastamos',
  'compré', 'compre', 'compramos',
  'costó', 'costo', 'cuestó', 'cuesto', 'costaron',
  'transferí', 'transferi', 'transfiera',
  'deposité', 'deposite', 'depósito', 'deposito',
  'aboné', 'abone', 'abono',
  'puse', 'puso', 'pusimos',
  'debemos', 'adeudamos', 'debo',
]

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseNumber(s: string): number | null {
  // Formatos: 18.000,50 / 18000,50 / 18,000.50 / 18000
  let cleaned = s.trim()
  if (cleaned.includes(',') && cleaned.includes('.')) {
    // 18,000.50 → el último es decimal
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      // 18.000,50
      cleaned = cleaned.replace(/\./g, '').replace(',', '.')
    } else {
      // 18,000.50
      cleaned = cleaned.replace(/,/g, '')
    }
  } else if (cleaned.includes(',')) {
    // Puede ser 18000,50 (decimal) o 18,000 (miles)
    const parts = cleaned.split(',')
    if (parts.length === 2 && parts[1].length <= 2) {
      cleaned = cleaned.replace(',', '.')
    } else {
      cleaned = cleaned.replace(/,/g, '')
    }
  } else if (cleaned.includes('.')) {
    // Puede ser 18.000 (miles) o 18.50 (decimal)
    const parts = cleaned.split('.')
    if (parts.length === 2 && parts[1].length <= 2) {
      // decimal
    } else {
      cleaned = cleaned.replace(/\./g, '')
    }
  }

  const n = parseFloat(cleaned)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** "18 mil" / "18k" / "18 m" → 18000; "18.000,00" → 18000 */
function parseNumberWithSuffix(s: string): number | null {
  const m = s.trim().match(/^(\d[\d.,]*)\s*(mil|k|m)?$/i)
  if (!m) return null
  const base = parseNumber(m[1])
  if (base === null) return null
  const suffix = (m[2] || '').toLowerCase()
  if (suffix === 'mil' || suffix === 'k' || suffix === 'm') {
    return base * 1000
  }
  return base
}

interface FoundNumber {
  match: string
  value: number
  index: number
}

/** Encuentra todos los montos candidatos (con sufijos mil/k/m) y su posición en el texto. */
function findNumbers(text: string, baseIndex = 0): FoundNumber[] {
  const out: FoundNumber[] = []
  const numRegex = /(\d[\d.,]*)\s*(mil|k|m)?(?![.\d])/gi
  for (const m of text.matchAll(numRegex)) {
    const numStr = m[1] + (m[2] ? ' ' + m[2] : '')
    const value = parseNumberWithSuffix(numStr)
    if (value !== null) {
      out.push({ match: m[0].trim(), value, index: baseIndex + m.index! })
    }
  }
  return out
}

function removeAt(text: string, found: FoundNumber): string {
  return text.slice(0, found.index) + ' ' + text.slice(found.index + found.match.length)
}

// Elige el monto mayor. La ventana del ancla suele contener también cantidades
// chicas (días, unidades) que no deben considerarse ambigüedad real; solo la
// marcamos si el segundo mayor es una fracción significativa del mayor (≥1/5).
function pickBest(numbers: FoundNumber[]): { best: FoundNumber; ambiguous: boolean } {
  const sorted = [...numbers].sort((a, b) => b.value - a.value)
  const best = sorted[0]
  const second = sorted[1]
  const ambiguous = !!second && best.value < second.value * 5
  return { best, ambiguous }
}

// El punto termina una oración solo si NO está dentro de un número
// (ej: "5000." o "5000. Ayer" → termina; "350.75" / "18.000" → no).
function truncateSentence(text: string, start: number): string {
  const maxLen = 100
  for (let i = start; i < text.length && i - start < maxLen; i++) {
    const ch = text[i]
    if (ch === '!' || ch === '?') return text.slice(start, i + 1)
    if (ch === '\n' || ch === '\r') return text.slice(start, i)
    if (ch === '.') {
      const next = text[i + 1]
      const nextIsDigit = next !== undefined && /\d/.test(next)
      if (!nextIsDigit) {
        return text.slice(start, i + 1)
      }
    }
  }
  return text.slice(start, start + maxLen)
}

function extractAmount(text: string): { amount: number | null; remaining: string; ambiguous: boolean } {
  // 1. Monto anclado a una palabra de dinero ("pagué $X", "costo X", "gasté X").
  //    Recorremos cada keyword de desembolso; la ventana de su oración se corta
  //    en el primer punto/!? que no sea parte de un número. Dentro de la ventana
  //    elegimos el número más grande (evita capturar días o cantidades chicas).
  const anchorVerbRegex = new RegExp(
    '(^|[^\\wáéíóúñ])(' + MONEY_ANCHOR_WORDS.map(escapeRegex).join('|') + ')',
    'gi',
  )
  for (const verbMatch of text.matchAll(anchorVerbRegex)) {
    const verbEnd = verbMatch.index! + verbMatch[0].length
    const windowText = truncateSentence(text, verbEnd)
    const numbers = findNumbers(windowText, verbEnd)
    if (numbers.length > 0) {
      const { best, ambiguous } = pickBest(numbers)
      return {
        amount: best.value,
        remaining: removeAt(text, best).replace(/\s+/g, ' ').trim(),
        ambiguous,
      }
    }
  }

  // 2. Monto con símbolo "$" (sin keyword previa)
  const dollarMatch = text.match(/[\$]\s*(\d[\d.,]*)\s*(mil|k|m)?(?![.\d])/i)
  if (dollarMatch) {
    const numStr = dollarMatch[1] + (dollarMatch[2] ? ' ' + dollarMatch[2] : '')
    const amount = parseNumberWithSuffix(numStr)
    if (amount !== null) {
      return {
        amount,
        remaining: text.replace(dollarMatch[0], ' ').replace(/\s+/g, ' ').trim(),
        ambiguous: false,
      }
    }
  }

  // 3. Heurística: el número más grande de todo el texto → ambiguo (candidato
  //    a confirmación, ya que no quedó anclado a una palabra de dinero).
  const numbers = findNumbers(text)
  if (numbers.length > 0) {
    const best = numbers.reduce((a, b) => (b.value > a.value ? b : a))
    return {
      amount: best.value,
      remaining: removeAt(text, best).replace(/\s+/g, ' ').trim(),
      ambiguous: true,
    }
  }

  return { amount: null, remaining: text, ambiguous: false }
}

function detectPaymentMethod(text: string): { method: string | null; remaining: string } {
  const lower = normalize(text)
  for (const [keyword, method] of Object.entries(PAYMENT_METHODS)) {
    if (lower.includes(keyword)) {
      return {
        method,
        remaining: text.replace(new RegExp(keyword.replace(/\s/g, '\\s+'), 'gi'), ' ').replace(/\s+/g, ' ').trim(),
      }
    }
  }
  return { method: null, remaining: text }
}

function detectSplitPayments(text: string): { payments: PaymentSplit[] | null; remaining: string } {
  // "965.167,69 por transferencia y 450.000 en efectivo"
  // "$965.167,69 por transferencia y 450.000 en efectivo"
  // "450.000 en efectivo y 965.167 por transferencia"
  const numPattern = '(\\$?\\s*\\d[\\d.,]*)'
  const methodPattern = '(por|en)\\s+(transferencia|efectivo|transferi|transferí|debito|débito|credito|crédito|qr|mercado\\s+pago|mp)'
  const fullPattern = new RegExp(
    `${numPattern}\\s*${methodPattern}\\s+y\\s+${numPattern}\\s*${methodPattern}`,
    'i'
  )
  const match = text.match(fullPattern)
  if (!match) return { payments: null, remaining: text }

  const cleanNum = (s: string) => s.replace(/[$\s]/g, '')
  const amount1 = parseNumber(cleanNum(match[1]))
  const method1Raw = match[3].toLowerCase()
  const amount2 = parseNumber(cleanNum(match[4]))
  const method2Raw = match[6].toLowerCase()

  if (!amount1 || !amount2) return { payments: null, remaining: text }

  const resolveMethod = (raw: string): string => {
    const m = raw.replace(/\s+/g, ' ').trim()
    return PAYMENT_METHODS[m] || m
  }

  return {
    payments: [
      { amount: amount1, payment_method: resolveMethod(method1Raw) },
      { amount: amount2, payment_method: resolveMethod(method2Raw) },
    ],
    remaining: text.replace(match[0], ' ').replace(/\s+/g, ' ').trim(),
  }
}

/**
 * Extrae datos de saldo/deuda restante ("El saldo en transferencia es 4.000.000...")
 * Devuelve los splits de saldo y el texto sin ellos.
 */
function parseSaldoStatements(text: string): { saldo: PaymentSplit[] | null; remaining: string } {
  const saldoPatterns = [
    // "saldo en transferencia es 4.000.000 y saldo en efectivo es 1.261.792,27"
    /(?:el\s+)?saldo\s+en\s+(transferencia|efectivo)\s+(?:es|de)\s+([\d.,]+)\s+y\s+(?:el\s+)?saldo\s+en\s+(transferencia|efectivo)\s+(?:es|de)\s+([\d.,]+)/i,
    // "saldo en transferencia es 4.000.000" (simple)
    /(?:el\s+)?saldo\s+en\s+(transferencia|efectivo)\s+(?:es|de)\s+([\d.,]+)/i,
  ]

  for (const pattern of saldoPatterns) {
    const match = text.match(pattern)
    if (!match) continue

    if (match[3]) {
      // Dos métodos: "saldo en X es A y saldo en Y es B"
      const method1 = match[1].toLowerCase()
      const amount1 = parseNumber(match[2])
      const method2 = match[3].toLowerCase()
      const amount2 = parseNumber(match[4])
      if (!amount1 || !amount2) continue
      return {
        saldo: [
          { amount: amount1, payment_method: PAYMENT_METHODS[method1] || method1 },
          { amount: amount2, payment_method: PAYMENT_METHODS[method2] || method2 },
        ],
        remaining: text.replace(match[0], ' ').replace(/\s+/g, ' ').trim(),
      }
    }

    // Un solo método
    const method = match[1].toLowerCase()
    const amount = parseNumber(match[2])
    if (!amount) continue
    return {
      saldo: [{ amount, payment_method: PAYMENT_METHODS[method] || method }],
      remaining: text.replace(match[0], ' ').replace(/\s+/g, ' ').trim(),
    }
  }

  return { saldo: null, remaining: text }
}

function cleanEntityName(name: string): string {
  // Remueve artículos al inicio del nombre para mejorar fuzzy match
  return name.replace(/^(la|el|los|las)\s+/i, '').trim() || name
}

function detectEntity(text: string): { provider: string | null; employee: string | null; remaining: string } {
  let remaining = text
  let provider: string | null = null
  let employee: string | null = null

  const lower = normalize(remaining)

  // "a proveedor X" o "proveedor X"
  const provMatch = remaining.match(/(?:a\s+)?proveedor\s+([a-záéíóúñ\s]+?)(?=\s+(?:costo|de\s+|por\s+|y\s+|\d|$))/i)
    || remaining.match(/(?:a\s+)?proveedor\s+([a-záéíóúñ]+)/i)
  if (provMatch) {
    provider = cleanEntityName(provMatch[1].trim())
    remaining = remaining.replace(provMatch[0], ' ').replace(/\s+/g, ' ').trim()
    return { provider, employee, remaining }
  }

  // "empleado X" o "a X" para sueldo
  if (!provider) {
    const empMatch = remaining.match(/(?:a\s+)?empleado\s+([a-záéíóúñ]+)/i)
      || remaining.match(/sueldo(?:\s+a)?\s+([a-záéíóúñ]+)/i)
    if (empMatch) {
      employee = cleanEntityName(empMatch[1].trim())
      remaining = remaining.replace(empMatch[0], ' ').replace(/\s+/g, ' ').trim()
      return { provider, employee, remaining }
    }
  }

  // "le pagamos a [nombre]" → proveedor
  const pagoMatch = remaining.match(/(?:le\s+)?(?:pagamos|pague|pagué|pago|pagaste|pagar)\s+a\s+([a-záéíóúñ]+(?:\s+[a-záéíóúñ]+)?)/i)
  if (pagoMatch) {
    provider = cleanEntityName(pagoMatch[1].trim())
    remaining = remaining.replace(pagoMatch[0], ' ').replace(/\s+/g, ' ').trim()
    return { provider, employee, remaining }
  }

  // "le debemos a [nombre]" o "adeudamos a [nombre]" → proveedor
  // Salta palabras intermedias como "pesos", "plata", etc.
  const deudaMatch = remaining.match(/(?:le\s+)?(?:debemos|adeudamos|debo|deuda)\s+(?:\S+\s+)?(?:a\s+)?([a-záéíóúñ]+(?:\s+[a-záéíóúñ]+)?)\s*$/i)
  if (deudaMatch) {
    provider = cleanEntityName(deudaMatch[1].trim())
    remaining = remaining.replace(deudaMatch[0], ' ').replace(/\s+/g, ' ').trim()
    return { provider, employee, remaining }
  }

  // Si no se detectó proveedor ni empleado, intentar "... a [nombre]" al final
  if (!provider && !employee) {
    const toMatch = remaining.match(/\ba\s+([a-záéíóúñ]+(?:\s+[a-záéíóúñ]+)?)\s*$/i)
    if (toMatch) {
      const before = remaining.slice(0, remaining.indexOf(toMatch[0])).toLowerCase()
      const cleaned = cleanEntityName(toMatch[1].trim())
      if (before.includes('sueldo') || before.includes('salario') || before.includes('pago de')) {
        employee = cleaned
      } else if (before.includes('debemos') || before.includes('adeudamos') || before.includes('deuda')) {
        provider = cleaned
      } else {
        provider = cleaned
      }
      remaining = remaining.replace(toMatch[0], ' ').replace(/\s+/g, ' ').trim()
    }
  }

  return { provider, employee, remaining }
}

function detectCategory(text: string): { category: string | null; remaining: string } {
  // Patrones: "de luz", "en alquiler", "por internet", "para limpieza"
  // Excluimos palabras que ya indican empleado/proveedor (sueldo, proveedor, empleado)
  const patterns = [
    /\b(de|en|por|para)\s+([a-záéíóúñ][a-záéíóúñ\s]{1,40})(?=\s+a\s+|\s+costo|\s+\d|$)/i,
    /\b(de|en|por|para)\s+([a-záéíóúñ][a-záéíóúñ\s]{1,40})/i,
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match) {
      const candidate = match[2].trim()
      const lower = candidate.toLowerCase()
      if (lower.includes('sueldo') || lower.includes('proveedor') || lower.includes('empleado') || lower.includes('salario')) {
        continue
      }
      return { category: candidate, remaining: text.replace(match[0], ' ').replace(/\s+/g, ' ').trim() }
    }
  }
  return { category: null, remaining: text }
}

function todayString(): string {
  return new Date().toISOString().slice(0, 10)
}

function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

function parseDateFromText(text: string): { date: string | null; remaining: string } {
  // "ayer"
  const ayerMatch = text.match(/\bayer\b/i)
  if (ayerMatch) {
    return { date: daysAgo(1), remaining: text.replace(ayerMatch[0], ' ').replace(/\s+/g, ' ').trim() }
  }

  // "anteayer"
  const anteayerMatch = text.match(/\banteayer\b/i)
  if (anteayerMatch) {
    return { date: daysAgo(2), remaining: text.replace(anteayerMatch[0], ' ').replace(/\s+/g, ' ').trim() }
  }

  // "hoy"
  const hoyMatch = text.match(/\bhoy\b/i)
  if (hoyMatch) {
    return { date: todayString(), remaining: text.replace(hoyMatch[0], ' ').replace(/\s+/g, ' ').trim() }
  }

  // "el 15/7/26" o "15/07/2026" o "15-7-26"
  const dateMatch = text.match(/el\s+(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/i)
  if (dateMatch) {
    let [_, d, m, y] = dateMatch
    let year = y.length === 2 ? '20' + y : y
    const dateStr = `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
    return { date: dateStr, remaining: text.replace(dateMatch[0], ' ').replace(/\s+/g, ' ').trim() }
  }

  // "15/7/26" sin "el"
  const bareDateMatch = text.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/)
  if (bareDateMatch) {
    let [_, d, m, y] = bareDateMatch
    let year = y.length === 2 ? '20' + y : y
    const dateStr = `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
    return { date: dateStr, remaining: text.replace(bareDateMatch[0], ' ').replace(/\s+/g, ' ').trim() }
  }

  return { date: null, remaining: text }
}

export function parseExpense(text: string): ParsedExpense {
  const raw = text.trim()
  if (!raw) {
    return {
      amount: null,
      description: null,
      category: null,
      provider: null,
      employee: null,
      payment_method: null,
      reference: null,
      date: todayString(),
      isExpenseIntent: false,
      raw,
    }
  }

  const normalized = normalize(raw)
  const isExpenseIntent = EXPENSE_INTENT_KEYWORDS.some(k => normalized.includes(k))

  // Extraer fecha primero
  let remaining = raw
  let date: string | null
  let parsedDate: { date: string | null; remaining: string }
  parsedDate = parseDateFromText(remaining)
  date = parsedDate.date
  remaining = parsedDate.remaining

  // Extraer datos de saldo
  let saldo: PaymentSplit[] | null = null
  let saldoResult = parseSaldoStatements(remaining)
  ;({ saldo, remaining } = saldoResult)

  // Detectar split payments antes de extraer monto individual
  let payments: PaymentSplit[] | null = null
  let splitResult = detectSplitPayments(remaining)
  ;({ payments, remaining } = splitResult)
  let amount: number | null = null
  let amountAmbiguous = false
  if (payments && payments.length > 1) {
    amount = payments.reduce((sum, p) => sum + p.amount, 0)
    remaining = splitResult.remaining
  } else {
    const amountResult = extractAmount(remaining)
    amount = amountResult.amount
    amountAmbiguous = amountResult.ambiguous
    remaining = amountResult.remaining
  }

  // Extraer método de pago
  const { method: payment_method, remaining: remaining2 } = detectPaymentMethod(remaining)
  remaining = remaining2

  // Extraer entidad (proveedor/empleado)
  const { provider, employee, remaining: remaining3 } = detectEntity(remaining)
  remaining = remaining3

  // Extraer categoría
  const { category, remaining: remaining4 } = detectCategory(remaining)
  remaining = remaining4

  // Limpiar conectores comunes (normalizamos acentos para que \b funcione)
  const normalizedRemaining = normalize(remaining)
  let description = normalizedRemaining
    .replace(/\b(gaste|gasto|pague|pago|compre|compra|paguemos|gastamos|compramos|deposite|deposito|transferi|transfiera|costo|cuesto|pagamos|pagaste|debemos|adeudamos|debo|pagar|puse|puso)\b/gi, ' ')
    .replace(/\b(hoy|le|a|de|el|la|los|las|del|al|por|para|con|en|un|una|unos|unas|lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo|saldo)\b/gi, ' ')
    .replace(/\b\d{4,}\b/g, ' ')
    .replace(/[.\s]{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!description || description.length < 2) {
    description = category || 'Gasto'
  }

  return {
    amount,
    description: description.charAt(0).toUpperCase() + description.slice(1),
    category,
    provider,
    employee,
    payment_method,
    payments: payments || undefined,
    saldo: saldo || undefined,
    reference: null,
    date: date || todayString(),
    isExpenseIntent,
    amountAmbiguous,
    raw,
  }
}

// Palabras de producto del catálogo (normalizadas, sin acentos). Si un verbo de
// COMPRA aparece junto a estas palabras (o a una medida tipo 60x40), es un
// pedido de cliente, NO un gasto del negocio.
const CATALOG_PRODUCT_WORDS = [
  'bastidor',
  'acrilico',
  'circular',
  'tela',
  'lienzo',
  'marco',
  'moldura',
]

const ORDER_COMPRA_VERBS = ['compre', 'compra', 'compramos', 'compraron', 'comprar']

function isCatalogOrder(normalized: string): boolean {
  const hasProduct = CATALOG_PRODUCT_WORDS.some(w => normalized.includes(w))
  const hasCompraVerb = ORDER_COMPRA_VERBS.some(v => normalized.includes(v))
  const hasMeasure = /\d{1,4}\s*x\s*\d{1,4}/.test(normalized)
  return hasCompraVerb && (hasProduct || hasMeasure)
}

// "pagué el pedido" → confirmación de pedido, NO gasto.
function isOrderMention(normalized: string): boolean {
  return /(pague|pago|pagamos|pagar|abone|abono)\s+(el|lo|un|mi|ese)?\s*pedido/.test(normalized)
}

export function looksLikeExpense(text: string): boolean {
  const normalized = normalize(text)
  if (!EXPENSE_INTENT_KEYWORDS.some(k => normalized.includes(k))) return false
  if (isCatalogOrder(normalized)) return false
  if (isOrderMention(normalized)) return false
  return true
}
