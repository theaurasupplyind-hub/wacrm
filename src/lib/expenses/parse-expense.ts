import type { ParsedExpense } from './types'

const EXPENSE_INTENT_KEYWORDS = [
  'gaste', 'gasté', 'gasto',
  'pague', 'pagué', 'pago',
  'compre', 'compré', 'compra',
  'paguemos', 'gastamos', 'compramos',
  'deposité', 'deposite', 'deposito',
  'transferí', 'transferi', 'transfiera',
  'costo', 'costó', 'cuesto',
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

function extractAmount(text: string): { amount: number | null; remaining: string } {
  // Buscar "costo $1234" o "costo 1234"
  const costMatch = text.match(/costo\s*[$\s]*(\d[\d.,]*)/i)
  if (costMatch) {
    const amount = parseNumber(costMatch[1])
    if (amount && amount > 0) {
      return { amount, remaining: text.replace(costMatch[0], ' ').trim() }
    }
  }

  // Buscar el primer número que parezca un monto
  const numMatch = text.match(/(\d[\d.,]*)/)
  if (numMatch) {
    const amount = parseNumber(numMatch[1])
    if (amount && amount > 0) {
      return { amount, remaining: text.replace(numMatch[1], ' ').trim() }
    }
  }

  return { amount: null, remaining: text }
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

function detectPaymentMethod(text: string): { method: string | null; remaining: string } {
  const lower = normalize(text)
  for (const [keyword, method] of Object.entries(PAYMENT_METHODS)) {
    if (lower.includes(keyword)) {
      return {
        method,
        remaining: text.replace(new RegExp(keyword, 'gi'), ' ').replace(/\s+/g, ' ').trim(),
      }
    }
  }
  return { method: null, remaining: text }
}

function detectEntity(text: string): { provider: string | null; employee: string | null; remaining: string } {
  let remaining = text
  let provider: string | null = null
  let employee: string | null = null

  // "a proveedor X" o "proveedor X"
  const provMatch = remaining.match(/(?:a\s+)?proveedor\s+([a-záéíóúñ\s]+?)(?=\s+(?:costo|de\s+|por\s+|\d|$))/i)
    || remaining.match(/(?:a\s+)?proveedor\s+([a-záéíóúñ\s]+)/i)
  if (provMatch) {
    provider = provMatch[1].trim()
    remaining = remaining.replace(provMatch[0], ' ').replace(/\s+/g, ' ').trim()
  }

  // "empleado X" o "a X" para sueldo
  if (!provider) {
    const empMatch = remaining.match(/(?:a\s+)?empleado\s+([a-záéíóúñ]+)/i)
      || remaining.match(/sueldo(?:\s+a)?\s+([a-záéíóúñ]+)/i)
    if (empMatch) {
      employee = empMatch[1].trim()
      remaining = remaining.replace(empMatch[0], ' ').replace(/\s+/g, ' ').trim()
    }
  }

  // Si no se detectó proveedor ni empleado, intentar "... a [nombre]" al final
  if (!provider && !employee) {
    const toMatch = remaining.match(/\ba\s+([a-záéíóúñ]+)\s*$/i)
    if (toMatch) {
      // Decidir si es proveedor o empleado por palabras cercanas
      const before = remaining.slice(0, remaining.indexOf(toMatch[0])).toLowerCase()
      if (before.includes('sueldo') || before.includes('salario') || before.includes('pago de')) {
        employee = toMatch[1].trim()
      } else {
        provider = toMatch[1].trim()
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

  // Extraer monto
  let { amount, remaining } = extractAmount(raw)

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
    .replace(/\b(gaste|gasto|pague|pago|compre|compra|paguemos|gastamos|compramos|deposite|deposito|transferi|transfiera|costo|cuesto)\b/gi, ' ')
    .replace(/\b(a|de|el|la|los|las|del|al|por|para|con|en|un|una|unos|unas)\b/gi, ' ')
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
    reference: null,
    date: todayString(),
    isExpenseIntent,
    raw,
  }
}

export function looksLikeExpense(text: string): boolean {
  const normalized = normalize(text)
  return EXPENSE_INTENT_KEYWORDS.some(k => normalized.includes(k))
}
