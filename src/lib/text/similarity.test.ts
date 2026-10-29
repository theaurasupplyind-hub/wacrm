import { describe, it, expect } from 'vitest'
import { jaro, jaroWinkler } from './similarity'

describe('jaroWinkler', () => {
  it('normaliza tildes/mayúsculas y da 1 para iguales', () => {
    expect(jaroWinkler('Martina', 'martína')).toBe(1)
  })

  it('"Martu" puntúa alto para nombres con el mismo prefijo', () => {
    // Es justamente la trampa: Martu se parece a Marta, Martin y Martina.
    expect(jaroWinkler('Martu', 'Martina')).toBeGreaterThan(0.8)
    expect(jaroWinkler('Martu', 'Marta')).toBeGreaterThan(0.8)
  })

  it('nombres distintos quedan abajo del umbral', () => {
    expect(jaroWinkler('Martu', 'Pepito')).toBeLessThan(0.6)
    expect(jaroWinkler('', 'Martina')).toBe(0)
  })

  it('jaro base es 0 sin caracteres en común', () => {
    expect(jaro('abc', 'xyz')).toBe(0)
  })
})
