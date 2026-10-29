import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { findClientMatchesFuzzy } from './client'

const clients = [
  { id: 1, nombre: 'Marta' },
  { id: 2, nombre: 'Mariu' },
  { id: 3, nombre: 'Martin' },
  { id: 4, nombre: 'Maruja' },
  { id: 5, nombre: 'Martina' },
  { id: 6, nombre: 'Pepito' },
]

describe('findClientMatchesFuzzy', () => {
  const originalUrl = process.env.FACBAL_API_URL
  const originalKey = process.env.FACBAL_API_KEY

  beforeEach(() => {
    process.env.FACBAL_API_URL = 'https://facbal.test'
    process.env.FACBAL_API_KEY = 'test-key'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(clients), { status: 200 })),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (originalUrl == null) delete process.env.FACBAL_API_URL
    else process.env.FACBAL_API_URL = originalUrl
    if (originalKey == null) delete process.env.FACBAL_API_KEY
    else process.env.FACBAL_API_KEY = originalKey
  })

  it('sugiere clientes parecidos y filtra por minScore', async () => {
    const matches = await findClientMatchesFuzzy('Martu', { limit: 8, minScore: 0.8 })
    const names = matches.map((m) => m.client.nombre)
    // La trampa: Marta puntúa más alto que Martina, pero ambas son sugerencias.
    expect(names).toContain('Marta')
    expect(names).toContain('Martina')
    expect(names).not.toContain('Pepito')
  })

  it('respeta el límite', async () => {
    const matches = await findClientMatchesFuzzy('Martu', { limit: 2, minScore: 0.8 })
    expect(matches).toHaveLength(2)
  })

  it('sin nombre no llama a la API', async () => {
    const matches = await findClientMatchesFuzzy('   ')
    expect(matches).toEqual([])
  })
})
