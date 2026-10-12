// Fuentes embebidas para la tarjeta de presupuesto (satori / next-og).
//
// Sin `fonts`, `ImageResponse` cae a su única fuente embebida (Geist Regular
// 400): todos los `fontWeight` del diseño se renderizan finos. Acá cargamos
// Inter en los cuatro pesos que usa la tarjeta.
//
// Los archivos viven en `public/fonts` (subset latin de @fontsource/inter,
// licencia OFL — ver LICENSE.txt) y se leen una sola vez: la promesa queda
// cacheada a nivel módulo, así que N requests comparten la misma lectura.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Familia a usar en `fontFamily` de la tarjeta. */
export const RECEIPT_FONT_FAMILY = 'Inter'

export interface ReceiptFont {
  name: string
  data: Buffer
  weight: 400 | 600 | 700 | 800
  style: 'normal'
}

const FONT_FILES: ReadonlyArray<{ file: string; weight: ReceiptFont['weight'] }> = [
  { file: 'Inter-Regular.woff', weight: 400 },
  { file: 'Inter-SemiBold.woff', weight: 600 },
  { file: 'Inter-Bold.woff', weight: 700 },
  { file: 'Inter-ExtraBold.woff', weight: 800 },
]

let cached: Promise<ReceiptFont[]> | null = null

/**
 * Devuelve el array `fonts` para `ImageResponse`. Cachea la lectura a nivel
 * módulo; si falla (p. ej. archivo faltante en el deploy) limpia el cache para
 * que el próximo request lo reintente en vez de quedarse con la promesa rota.
 */
export function getReceiptFonts(): Promise<ReceiptFont[]> {
  cached ??= Promise.all(
    FONT_FILES.map(async ({ file, weight }) => ({
      name: RECEIPT_FONT_FAMILY,
      data: await readFile(join(process.cwd(), 'public', 'fonts', file)),
      weight,
      style: 'normal' as const,
    })),
  ).catch((err) => {
    cached = null
    throw err
  })

  return cached
}
