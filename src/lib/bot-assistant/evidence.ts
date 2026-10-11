/**
 * Compacta la evidencia de tools antes de pasarla al responder.
 *
 * Los handlers devuelven listas crudas de FacBal (hasta 50 gastos, asistencias
 * por empleado). Volcarlas enteras al prompt infla tokens y aumenta el riesgo
 * de que el modelo mezcle o invente datos. Acá se recortan las listas de
 * EVENTOS, manteniendo la forma que el prompt espera (siguen siendo arrays; no
 * se envuelven en objetos).
 *
 * Los CATÁLOGOS de referencia (categorías, proveedores, empleados) NO se
 * truncan: el asistente los necesita completos (ej. listar todas las
 * categorías al preguntar "¿con qué categorías puedo registrar un gasto?").
 */

const DEFAULT_MAX_ITEMS = 15
const MAX_DEPTH = 3

/** Claves de catálogo: se pasan completas al prompt. */
export const CATALOG_KEYS = new Set([
  'expense_categories',
  'categories',
  'providers',
  'employees',
  'employees_for_attendance',
])

function compactValue(value: unknown, maxItems: number, depth: number): unknown {
  if (Array.isArray(value)) {
    if (!Number.isFinite(maxItems) || value.length <= maxItems) {
      return value.map((v) => compactValue(v, maxItems, depth + 1))
    }
    const sliced = value.slice(0, maxItems).map((v) => compactValue(v, maxItems, depth + 1))
    sliced.push(`…(${value.length - maxItems} más)`)
    return sliced
  }
  if (value && typeof value === 'object' && depth < MAX_DEPTH) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = compactValue(v, maxItems, depth + 1)
    }
    return out
  }
  return value
}

/**
 * Devuelve una copia de `results` con las listas de eventos recortadas a
 * `maxItems`; los catálogos (ver `CATALOG_KEYS`) quedan intactos.
 * `null`/`undefined` se preservan.
 */
export function compactToolResults(
  results: Record<string, unknown> | null | undefined,
  maxItems: number = DEFAULT_MAX_ITEMS,
): Record<string, unknown> | null {
  if (!results) return null
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(results)) {
    const limit = CATALOG_KEYS.has(k) ? Number.POSITIVE_INFINITY : maxItems
    out[k] = compactValue(v, limit, 0)
  }
  return out
}
