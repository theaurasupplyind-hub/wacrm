import { describe, it, expect } from 'vitest'
import {
  ECOSYSTEM,
  ecosystemIsConsistent,
  ecosystemNodeIds,
  statusCounts,
} from './ecosystem'

describe('ecosystem map', () => {
  it('todas las aristas apuntan a nodos existentes', () => {
    expect(ecosystemIsConsistent()).toBe(true)
  })

  it('no hay ids de nodo duplicados', () => {
    const ids = ECOSYSTEM.nodes.map((n) => n.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('no hay ids de arista duplicados', () => {
    const ids = ECOSYSTEM.edges.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('no hay nodos aislados (todo nodo tiene al menos una arista)', () => {
    const connected = new Set<string>()
    for (const e of ECOSYSTEM.edges) {
      connected.add(e.source)
      connected.add(e.target)
    }
    const isolated = [...ecosystemNodeIds()].filter((id) => !connected.has(id))
    expect(isolated).toEqual([])
  })

  it('statusCounts coincide con los nodos', () => {
    const counts = statusCounts()
    const total = Object.values(counts).reduce((a, b) => a + b, 0)
    expect(total).toBe(ECOSYSTEM.nodes.length)
  })
})
