import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const facbal = vi.hoisted(() => ({
  getPreciosReferencia: vi.fn(),
  getPricingRules: vi.fn(),
}))

vi.mock('@/lib/facbal/client', () => facbal)

import { preciosReferencia, pricingRules } from '@/lib/precios/__fixtures__/catalogo'
import type { PrecioReferencia } from '@/lib/precios'
import {
  buildVocabulary,
  getVocabulary,
  invalidateVocabulary,
  mentionsProduct,
  mentionsCatalogTerm,
  buildVocabularyPromptBlock,
  __resetVocabularyCache,
  VOCABULARY_TTL_MS,
} from './vocabulary'

beforeEach(() => {
  __resetVocabularyCache()
  facbal.getPreciosReferencia.mockReset().mockResolvedValue(preciosReferencia)
  facbal.getPricingRules.mockReset().mockResolvedValue(pricingRules)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('buildVocabulary', () => {
  it('deriva categorías, variantes, reglas y palabras conocidas del catálogo', () => {
    const v = buildVocabulary(preciosReferencia, pricingRules)
    expect(v.categorias).toContain('BASTIDOR')
    expect(v.categorias).toContain('ROLLO DE TELA')
    expect(v.variantes).toContain('Sin Tela')
    expect(v.knownWords).toContain('bastidor')
    expect(v.rules.length).toBe(pricingRules.length)
    expect(v.categoriaDefault).toBe('BASTIDOR')
    expect(v.sinonimos.size).toBe(0)
  })
})

describe('getVocabulary (cacheado)', () => {
  it('cachea por cuenta: dos turnos seguidos = una sola carga', async () => {
    const a = await getVocabulary('acc-1')
    const b = await getVocabulary('acc-1')
    expect(a).toBe(b)
    expect(facbal.getPreciosReferencia).toHaveBeenCalledTimes(1)
    expect(facbal.getPricingRules).toHaveBeenCalledTimes(1)

    await getVocabulary('acc-2')
    expect(facbal.getPreciosReferencia).toHaveBeenCalledTimes(2)
  })

  it('deduplica cargas concurrentes de la misma cuenta', async () => {
    let release: (v: unknown) => void = () => {}
    facbal.getPreciosReferencia.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    const p1 = getVocabulary('acc-1')
    const p2 = getVocabulary('acc-1')
    release(preciosReferencia)
    const [v1, v2] = await Promise.all([p1, p2])
    expect(v1).toBe(v2)
    expect(facbal.getPreciosReferencia).toHaveBeenCalledTimes(1)
  })

  it('invalidateVocabulary fuerza la recarga', async () => {
    await getVocabulary('acc-1')
    invalidateVocabulary('acc-1')
    await getVocabulary('acc-1')
    expect(facbal.getPreciosReferencia).toHaveBeenCalledTimes(2)
  })

  it('ante error de red devuelve la última copia buena', async () => {
    vi.useFakeTimers()
    const warm = await getVocabulary('acc-1')
    vi.advanceTimersByTime(VOCABULARY_TTL_MS + 1)
    facbal.getPreciosReferencia.mockRejectedValueOnce(new Error('net down'))
    const after = await getVocabulary('acc-1')
    expect(after).toBe(warm)
  })
})

describe('mentionsProduct / mentionsCatalogTerm (Plan A1)', () => {
  // Catálogo con un producto que NO existe en el repo: si el gate lo reconoce,
  // el reconocimiento es data-driven (no hardcodeado).
  const nueva: PrecioReferencia = { categoria: 'CORTINA ROLLER', medida: '100 x 100', variante: '', precio: 1000 }
  const vocab = buildVocabulary([...preciosReferencia, nueva], pricingRules)

  it('reconoce una categoría nueva del catálogo (con plural)', () => {
    expect(mentionsProduct('quiero una cortina roller', vocab)).toBe(true)
    expect(mentionsProduct('2 cortinas roller', vocab)).toBe(true)
    expect(mentionsProduct('un bastidor 60x40', vocab)).toBe(true)
  })

  it('NO trata los insumos de las reglas como producto', () => {
    expect(mentionsProduct('pagué pintura para el taller', vocab)).toBe(false)
    expect(mentionsCatalogTerm('pagué pintura para el taller', vocab)).toBe(true)
  })

  it('sin coincidencia → false', () => {
    expect(mentionsProduct('hola, cómo va?', vocab)).toBe(false)
    expect(mentionsCatalogTerm('hola, cómo va?', vocab)).toBe(false)
  })
})

describe('buildVocabularyPromptBlock (Plan A2)', () => {
  const vocab = buildVocabulary(preciosReferencia, pricingRules)

  it('incluye categorías, variantes y reglas con su ajuste de precio', () => {
    const block = buildVocabularyPromptBlock(vocab)
    expect(block).toContain('BASTIDOR')
    expect(block).toContain('Sin Tela')
    expect(block).toContain('Cambio de Tela (-50%)')
  })

  it('NUNCA incluye los términos aprendidos del glosario (se aplican antes de clasificar)', () => {
    const conSinonimos = { ...vocab, sinonimos: new Map([['fantasia', 'Sin Tela']]) }
    const block = buildVocabularyPromptBlock(conSinonimos)
    expect(block).not.toContain('Términos ya aprendidos')
    expect(block).not.toContain('fantasia')
  })

  it('trim por consumidor: sin ajustes de precio y sin reglas', () => {
    const sinAjustes = buildVocabularyPromptBlock(vocab, { ruleAdjustments: false })
    expect(sinAjustes).toContain('Pinturas')
    expect(sinAjustes).not.toContain('(+10%)')

    const sinReglas = buildVocabularyPromptBlock(vocab, { rules: false })
    expect(sinReglas).toContain('Variantes')
    expect(sinReglas).not.toContain('Reglas de precio')
  })

  it('sin vocabulario devuelve la instrucción genérica', () => {
    expect(buildVocabularyPromptBlock(null)).toMatch(/CATÁLOGO:/)
    expect(buildVocabularyPromptBlock(undefined)).not.toContain('- Categorías')
  })
})
