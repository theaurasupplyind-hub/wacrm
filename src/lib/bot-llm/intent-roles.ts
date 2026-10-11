import type { UnifiedExtraction } from './types'

/**
 * Enriquecimiento de una extracción de voucher a partir de los roles tipados.
 *
 * La DECISIÓN voucher vs gasto NO vive acá: la resuelve el clasificador
 * determinístico de pagos (`payment-intent.ts`), que además es el que fuerza la
 * aclaración en la banda ambigua. Este módulo solo completa campos faltantes
 * del voucher (`proveedor`/`destino`) usando `payer`/`payee` que devolvió el LLM,
 * sin pisar lo ya presente y sin crear objetos nuevos si no hay nada que hacer.
 */
export function applyRoleFields(extraction: UnifiedExtraction): UnifiedExtraction {
  if (extraction.intent !== 'voucher') return extraction
  const curProveedor = extraction.proveedor ?? null
  const curDestino = extraction.destino ?? null
  const proveedor = curProveedor ?? extraction.payer ?? null
  const destino = curDestino ?? extraction.payee ?? null
  if (proveedor === curProveedor && destino === curDestino) return extraction
  return { ...extraction, proveedor, destino }
}
