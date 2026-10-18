import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const facbal = vi.hoisted(() => ({
  getPreciosReferencia: vi.fn(),
  getPricingRules: vi.fn(),
}))

vi.mock('@/lib/facbal/client', () => facbal)

import { preciosReferencia, pricingRules } from '@/lib/precios/__fixtures__/catalogo'
import {
  buildVocabulary,
  getVocabulary,
  invalidateVocabulary,
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
