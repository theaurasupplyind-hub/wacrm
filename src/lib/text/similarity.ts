import { normalizeText } from './normalize'

/**
 * Similitud de strings para nombres de clientes.
 *
 * Jaro-Winkler premia los prefijos comunes ("Martu" ~ "Martina") y tolera
 * errores de tipeo. Se usa SOLO como sugerencia: un score alto no prueba
 * identidad (Marta también puntúa alto para "Martu"), así que el pipeline de
 * vouchers siempre cruza las sugerencias con facturas pendientes y pide
 * confirmación antes de pagar.
 */

/** Jaro similarity (0..1) entre dos strings ya normalizados. */
export function jaro(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1

  const matchDistance = Math.floor(Math.max(a.length, b.length) / 2) - 1
  const aMatches = new Array<boolean>(a.length).fill(false)
  const bMatches = new Array<boolean>(b.length).fill(false)

  let matches = 0
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchDistance)
    const end = Math.min(i + matchDistance + 1, b.length)
    for (let j = start; j < end; j++) {
      if (!bMatches[j] && a[i] === b[j]) {
        aMatches[i] = true
        bMatches[j] = true
        matches++
        break
      }
    }
  }

  if (matches === 0) return 0

  let transpositions = 0
  let k = 0
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue
    while (!bMatches[k]) k++
    if (a[i] !== b[k]) transpositions++
    k++
  }
  transpositions /= 2

  return (
    matches / a.length +
    matches / b.length +
    (matches - transpositions) / matches
  ) / 3
}

/** Jaro-Winkler (0..1) con normalización (sin tildes, minúsculas). */
export function jaroWinkler(a: string, b: string): number {
  const na = normalizeText(a)
  const nb = normalizeText(b)
  const j = jaro(na, nb)
  let prefix = 0
  while (prefix < 4 && prefix < na.length && prefix < nb.length && na[prefix] === nb[prefix]) {
    prefix++
  }
  return j + prefix * 0.1 * (1 - j)
}
