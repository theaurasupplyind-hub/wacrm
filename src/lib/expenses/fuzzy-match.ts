import {
  listExpenseCategories,
  createExpenseCategory,
  searchClients,
  type ExpenseCategory,
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
  if (na.startsWith(nb) || nb.startsWith(na)) return 0.9
  if (na.includes(nb) || nb.includes(na)) return 0.8
  const tokensA = na.split(' ')
  const tokensB = nb.split(' ')
  const common = tokensA.filter(t => tokensB.some(bt => bt.includes(t) || t.includes(bt)))
  return common.length / Math.max(tokensA.length, tokensB.length)
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
  const category = await resolveExpenseCategory(parsed.category, categories)

  let providerId: number | null = null
  let providerName: string | null = null
  let employeeId: number | null = null
  let employeeName: string | null = null

  if (parsed.provider) {
    // Buscar en clientes? No, proveedores no están en /clients. Por ahora no resolvemos.
    // En una v2 se agregará endpoint de búsqueda de proveedores.
    providerName = parsed.provider
  }

  if (parsed.employee) {
    // Buscar empleado por nombre en /clients? No, empleados son otra tabla.
    // Por ahora no resolvemos automáticamente.
    employeeName = parsed.employee
  }

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
