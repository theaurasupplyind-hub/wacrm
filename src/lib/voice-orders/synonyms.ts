// Sinónimos de catálogo Bastidores GAL — mapeo no destructivo para grounding
// Se usa tanto en parse-order (prompt) como en execute-order (retry)

export const SINONIMOS_CATEGORIA: Record<string, string> = {
  // bastidor grueso
  cajon: 'bastidor doble 4cm',
  caja: 'bastidor doble 4cm',
  'caja bastidor': 'bastidor doble 4cm',
  // tapacanto
  marco: 'tapacanto',
  marcos: 'tapacanto',
  tapacantos: 'tapacanto',
}

export const SINONIMOS_VARIANTE: Record<string, string> = {
  caja: 'Doble 4cm',
  cajon: 'Doble 4cm',
  'doble': 'Doble 4cm',
  '4cm': 'Doble 4cm',
  '4 cm': 'Doble 4cm',
  'lo mas ancho': 'Doble 4cm',
  'lo más ancho': 'Doble 4cm',
  ancho: 'Doble 4cm',
  lp: 'Lienzo Profesional',
  'con tela': 'Lienzo Profesional',
}

export const SINONIMOS_PRODUCTO: Record<string, { categoria: string; variante: string | null; medida?: string | null; descripcion: string }> = {
  // Acrílicos Serie 2 — mapeo por alias coloquial
  'acrilico verde viridiano chico': { categoria: 'acrilico', variante: null, descripcion: 'Acrilico Serie 2 60cc verde viridiano' },
  'acrilico viridiano chico': { categoria: 'acrilico', variante: null, descripcion: 'Acrilico Serie 2 60cc' },
  'viridiano chico': { categoria: 'acrilico', variante: null, descripcion: 'Acrilico Serie 2 60cc' },
  'acrilico verde chico': { categoria: 'acrilico', variante: null, descripcion: 'Acrilico Serie 2 60cc' },
  'acrilico blanco grande': { categoria: 'acrilico', variante: null, descripcion: 'Acrilico Serie 2 200cc blanco' },
  'viridiano grande': { categoria: 'acrilico', variante: null, descripcion: 'Acrilico Serie 2 200cc' },
  'blanco grande': { categoria: 'acrilico', variante: null, descripcion: 'Acrilico Serie 2 200cc blanco' },
}

export function expandirSinonimos(text: string): string {
  let lower = text.toLowerCase()
  // Primero productos compuestos (más específicos)
  for (const [alias, map] of Object.entries(SINONIMOS_PRODUCTO)) {
    if (lower.includes(alias)) {
      // Reemplazar alias por descripción canónica para que suggestPrice matchee
      lower = lower.replace(alias, map.descripcion.toLowerCase())
    }
  }
  // Luego categorías
  for (const [alias, canon] of Object.entries(SINONIMOS_CATEGORIA)) {
    if (lower.includes(alias)) {
      lower = lower.replace(alias, canon)
    }
  }
  return lower
}

export function getSinonimoVariante(descripcion: string): string | null {
  const lower = descripcion.toLowerCase()
  if (lower.includes('cajon') || lower.includes('caja') || lower.includes('lo mas ancho') || lower.includes('lo más ancho') || lower.includes('4cm') || lower.includes('4 cm')) {
    return 'Doble 4cm'
  }
  if (lower.includes('marco')) return null // marco es categoria tapacanto, no variante
  return null
}

export const SINONIMOS_PROMPT_BLOCK = `
=== SINÓNIMOS DE CATÁLOGO (MAPEO NO INVENTIVO) ===
- "cajón", "caja", "lo más ancho", "4cm/5cm de profundidad", "onda caja" → variante "Doble 4cm" (bastidor grueso). Ej: "9 bastidores 40x40 caja 4cm" → categoria bastidor, medida 40x40, variante Doble 4cm.
- "marco", "marcos" → categoria "tapacanto" (no bastidor). Ej: "2 marcos 60x80" → tapacanto 60x80.
- "acrílico verde viridiano chico" → acrilico Serie 2 60cc. "acrílico blanco grande" / "viridiano grande" → acrilico Serie 2 200cc. Si dice "viridiano" o "acrílico" sin tamaño claro, poné variante null y categoria acrilico.
- "rollo 1,5 x 5" / "rollo" → categoria "producto" o null, medida 150x500 aprox (1,5m x 5m). Si no hay medida clara poné null.
- "lienzo", "lona", "tela" solos sin 4cm → variante según mención explícita, si no null.
NUNCA inventes variante si el sinónimo no está explícito. Si dice "lo más ancho posible, onda caja, si pueden ser de 4-5cm ideal" → variante Doble 4cm con dudoso=false pero confianza alta porque hay pista fuerte.
`
