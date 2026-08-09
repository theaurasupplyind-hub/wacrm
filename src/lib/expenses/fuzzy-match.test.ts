import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tokenScore } from './fuzzy-match'

const mockProviders = [{ id: 1, name: 'Jolden S.A. Grapas', balance: 0, stock_qty: 0 }]
const mockEmployees: unknown[] = []
const mockCategories = [
  {
    id: 5,
    name: 'Pago a proveedor',
    slug: 'pago-a-proveedor',
    color: '#2980b9',
    icon: '🛒',
    type: 'operativo',
    is_default: 0,
    created_by: null,
    created_at: '2026-01-01T00:00:00Z',
  },
]

vi.mock('@/lib/facbal/client', () => ({
  listProviders: vi.fn(async () => mockProviders),
  listEmployees: vi.fn(async () => mockEmployees),
  listExpenseCategories: vi.fn(async () => mockCategories),
  createExpenseCategory: vi.fn(async () => {
    throw new Error('should not create category in these tests')
  }),
}))

describe('tokenScore', () => {
  it('returns 0 for empty input', () => {
    expect(tokenScore('', 'Easy')).toBe(0)
    expect(tokenScore('Jolden S.A. Grapas', '')).toBe(0)
  })

  it('returns 1 for exact matches', () => {
    expect(tokenScore('Easy', 'Easy')).toBe(1)
    expect(tokenScore('Ferretería San Martín', 'ferreteria san martin')).toBe(1)
  })

  it('does not match single-letter tokens inside "S.A." suffixes', () => {
    // Regression: "S.A." normalizes to tokens "s" and "a"; both letters appear
    // in "easy", which previously inflated the score to 0.7 and wrongly matched
    // "Easy" -> "Jolden S.A. Grapas".
    expect(tokenScore('Jolden S.A. Grapas', 'Easy')).toBe(0)
    expect(tokenScore('Jolden S.A. Grapas', 'Easy')).toBeLessThan(0.6)
  })

  it('keeps real provider matches', () => {
    expect(tokenScore('Jolden S.A. Grapas', 'Jolden')).toBeGreaterThanOrEqual(0.6)
    expect(tokenScore('Jolden S.A. Grapas', 'grapas')).toBeGreaterThanOrEqual(0.6)
  })

  it('ignores short whole-string substrings', () => {
    // "ia" is a substring of "anselmo garcia" but too short to be meaningful.
    expect(tokenScore('Anselmo García', 'ia')).toBe(0)
    expect(tokenScore('Anselmo García', 'ia')).toBeLessThan(0.6)
  })

  it('keeps meaningful substrings', () => {
    expect(tokenScore('Ferretería San Martín', 'martin')).toBeGreaterThan(0)
  })
})

describe('resolveExpenseEntities', () => {
  let fuzzyMatchExpense: typeof import('./fuzzy-match').fuzzyMatchExpense

  beforeEach(async () => {
    const mod = await import('./fuzzy-match')
    fuzzyMatchExpense = mod.fuzzyMatchExpense
  })

  function parsed(provider: string) {
    return {
      amount: 175000,
      description: 'Chapadour Plus',
      category: 'Pago a proveedor',
      provider,
      employee: null,
      payment_method: 'efectivo',
      reference: null,
      date: '2026-08-08',
      isExpenseIntent: true,
      raw: `pagamos 175000 en Chapadour Plus en ${provider}`,
    }
  }

  it('leaves unknown providers unmatched', async () => {
    const match = await fuzzyMatchExpense(parsed('Easy'))
    expect(match.providerId).toBeNull()
    expect(match.providerName).toBe('Easy')
    expect(match.categoryId).toBe(5)
  })

  it('resolves real providers', async () => {
    const match = await fuzzyMatchExpense(parsed('Jolden'))
    expect(match.providerId).toBe(1)
    expect(match.providerName).toBe('Jolden S.A. Grapas')
  })
})
