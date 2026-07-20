import {
  listExpenseCategories,
  createExpenseCategory,
  listProviders,
  listEmployees,
  type ExpenseCategory,
  type Provider,
  type Employee,
} from '@/lib/facbal/client'
import type { ParsedExpense, ExpenseFuzzyMatch } from './types'

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenScore(a: string, b: string): number {
  const na = normalize(a)
  const nb = normalize(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  if (na.startsWith(nb) || nb.startsWith(na)) {
    const longer = na.length >= nb.length ? na : nb
    const shorter = na.length >= nb.length ? nb : na
    const longerTokens = longer.split(/\s+/).length
    const shorterTokens = shorter.split(/\s+/).length
    if (shorterTokens > 0 && longerTokens > shorterTokens * 1.5) {
      return 0.6 + 0.35 * (shorterTokens / longerTokens)
    }
    return 0.95
  }
  if (na.includes(nb) || nb.includes(na)) return 0.85

  const tokensA = na.split(' ')
  const tokensB = nb.split(' ')

  const stem = (w: string) => w.endsWith('s') ? w.slice(0, -1) : w
  const matchToken = (ta: string, tb: string) =>
    ta === tb || stem(ta) === stem(tb) || ta.includes(tb) || tb.includes(ta)

  const common = tokensA.filter(t => tokensB.some(bt => matchToken(t, bt)))
  const score = common.length / Math.max(tokensA.length, tokensB.length)

  const strongMatch = tokensA.some(t => tokensB.some(bt => t.includes(bt) || bt.includes(t)))
  if (strongMatch && score > 0) {
    return Math.min(score + 0.2, 0.95)
  }

  return score
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function pickColor(type: string): string {
  const colors: Record<string, string> = {
    operativo: '#2980b9',
    administrativo: '#3498db',
    personal: '#e74c3c',
    logistica: '#f39c12',
    otros: '#95a5a6',
  }
  return colors[type] || '#3498db'
}

function pickIcon(type: string): string {
  const icons: Record<string, string> = {
    operativo: '🛒',
    administrativo: '📁',
    personal: '👷',
    logistica: '🚚',
    otros: '📄',
  }
  return icons[type] || '📁'
}

export async function resolveExpenseCategory(
  categoryName: string | null,
  categories?: ExpenseCategory[],
): Promise<{ categoryId: number | null; categoryName: string | null; created: boolean }> {
  if (!categoryName) {
    return { categoryId: null, categoryName: null, created: false }
  }

  const cats = categories || (await listExpenseCategories())
  const target = normalize(categoryName)
  let best: ExpenseCategory | null = null
  let bestScore = 0

  for (const cat of cats) {
    const score = tokenScore(cat.name, categoryName)
    if (score > bestScore) {
      bestScore = score
      best = cat
    }
  }

  if (best && bestScore >= 0.6) {
    return { categoryId: best.id, categoryName: best.name, created: false }
  }

  // Crear categoría automáticamente
  const slug = slugify(categoryName)
  const type = 'otros'
  try {
    const created = await createExpenseCategory({
      name: categoryName,
      slug,
      color: pickColor(type),
      icon: pickIcon(type),
      type,
      is_default: 0,
      created_by: null,
    })
    return { categoryId: created.id, categoryName: created.name, created: true }
  } catch (e) {
    // Si falló porque ya existe, intentar listar de nuevo
    const retry = await listExpenseCategories()
    const found = retry.find(c => normalize(c.name) === target || c.slug === slug)
    if (found) {
      return { categoryId: found.id, categoryName: found.name, created: false }
    }
    throw e
  }
}

export async function resolveExpenseEntities(
  parsed: ParsedExpense,
): Promise<ExpenseFuzzyMatch> {
  const categories = await listExpenseCategories()

  let providerId: number | null = null
  let providerName: string | null = null
  let employeeId: number | null = null
  let employeeName: string | null = null

  const needsMatch = Boolean(parsed.provider || parsed.employee)
  const providers = needsMatch ? await listProviders() : []
  const employees = needsMatch ? await listEmployees() : []

  // Cross-match parsed.provider against BOTH lists
  if (parsed.provider) {
    let bestProvScore = 0
    let bestProv: Provider | null = null
    for (const prov of providers) {
      const score = tokenScore(prov.name, parsed.provider)
      if (score > bestProvScore) { bestProvScore = score; bestProv = prov }
    }

    let bestEmpScore = 0
    let bestEmp: Employee | null = null
    for (const emp of employees) {
      const score = tokenScore(emp.name, parsed.provider)
      if (score > bestEmpScore) { bestEmpScore = score; bestEmp = emp }
    }

    if (bestProv && bestProvScore >= 0.6 && bestProvScore >= bestEmpScore) {
      providerId = bestProv.id; providerName = bestProv.name
    } else if (bestEmp && bestEmpScore >= 0.6) {
      employeeId = bestEmp.id; employeeName = bestEmp.name
    } else {
      providerName = parsed.provider
    }
  }

  // Cross-match parsed.employee against BOTH lists
  if (parsed.employee) {
    let bestEmpScore = 0
    let bestEmp: Employee | null = null
    for (const emp of employees) {
      const score = tokenScore(emp.name, parsed.employee)
      if (score > bestEmpScore) { bestEmpScore = score; bestEmp = emp }
    }

    let bestProvScore = 0
    let bestProv: Provider | null = null
    for (const prov of providers) {
      const score = tokenScore(prov.name, parsed.employee)
      if (score > bestProvScore) { bestProvScore = score; bestProv = prov }
    }

    if (bestEmp && bestEmpScore >= 0.6 && bestEmpScore >= bestProvScore) {
      employeeId = bestEmp.id; employeeName = bestEmp.name
    } else if (bestProv && bestProvScore >= 0.6) {
      providerId = bestProv.id; providerName = bestProv.name
    } else if (!employeeName) {
      employeeName = parsed.employee
    }
  }

  // Infer category based on resolved entity type when no explicit category
  let categoryNameToUse = parsed.category
  if (!categoryNameToUse) {
    if (employeeId || employeeName) {
      categoryNameToUse = 'Sueldos y salarios'
    } else if (providerId || providerName) {
      const normalized = normalize(parsed.raw || '')
      categoryNameToUse = normalized.includes('debemos') || normalized.includes('adeudamos') || normalized.includes('deuda')
        ? 'Compra a proveedor'
        : 'Pago a proveedor'
    }
  }

  const category = await resolveExpenseCategory(categoryNameToUse, categories)

  return {
    categoryId: category.categoryId,
    categoryName: category.categoryName,
    categoryWasCreated: category.created,
    providerId,
    providerName,
    employeeId,
    employeeName,
  }
}

export async function fuzzyMatchExpense(
  parsed: ParsedExpense,
): Promise<ExpenseFuzzyMatch> {
  return resolveExpenseEntities(parsed)
}
