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
  // rollo
  rollo: 'ROLLO DE TELA',
  'rollo de tela': 'ROLLO DE TELA',
  'rollo tela': 'ROLLO DE TELA',
}

export const SINONIMOS_VARIANTE: Record<string, string> = {
  caja: 'Doble 4cm',
  cajon: 'Doble 4cm',
  'onda caja': 'Doble 4cm',
  'doble': 'Doble 4cm',
  '4cm': 'Doble 4cm',
  '4 cm': 'Doble 4cm',
  '4.5cm': 'Doble 4cm',
  '4,5cm': 'Doble 4cm',
  '4.5 cm': 'Doble 4cm',
  '4,5 cm': 'Doble 4cm',
  'lo mas ancho': 'Doble 4cm',
  'lo más ancho': 'Doble 4cm',
  'lo mas anchos': 'Doble 4cm',
  'lo más anchos': 'Doble 4cm',
  ancho: 'Doble 4cm',
  anchos: 'Doble 4cm',
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
  // Normalizar coma decimal para 4,5cm → 4.5cm
  const normalized = lower.replace(/4\s*,\s*5/g, '4.5')
  if (normalized.includes('4.5cm') || normalized.includes('4.5 cm') || normalized.includes('4.5')) {
    // Solo si está cerca de cm o caja/grosor (evitar falsos positivos de "4.5" suelto no es bastidor?)
    if (normalized.includes('cm') || normalized.includes('caja') || normalized.includes('cajon') || normalized.includes('doble') || normalized.includes('grosor') || normalized.includes('grueso') || normalized.includes('ancho') || normalized.includes('40x40') || normalized.includes('bastidor')) {
      return 'Doble 4cm'
    }
  }
  // Expansión para 4, 5 cm con coma intermedia (plural)
  const has4y5 = /4\s*,\s*5\s*cm/.test(lower) || /4\s*y\s*5\s*cm/.test(lower) || /4\s*-\s*5\s*cm/.test(lower)
  if (has4y5) return 'Doble 4cm'
  if (lower.includes('cajon') || lower.includes('caja') || lower.includes('onda caja') || lower.includes('lo mas ancho') || lower.includes('lo más ancho') || lower.includes('lo mas anchos') || lower.includes('lo más anchos') || lower.includes('4cm') || lower.includes('4 cm') || lower.includes('anchos')) {
    return 'Doble 4cm'
  }
  if (lower.includes('marco')) return null // marco es categoria tapacanto, no variante
  return null
}

export const SINONIMOS_PROMPT_BLOCK = `
=== SINÓNIMOS DE CATÁLOGO (MAPEO NO INVENTIVO) ===
- "cajón", "caja", "onda caja", "lo más ancho/anchos", "4cm/5cm de profundidad", "4,5cm/4.5cm" → variante "Doble 4cm" (bastidor grueso). Ej: "9 bastidores 40x40 caja 4,5cm" → categoria bastidor, medida 40x40, variante Doble 4cm. "40x40 4,5cm" o "40x40 4.5 cm" → Doble 4cm sin preguntar.
- "grosor", "más grueso", "grueso", "ancho profundo" SIN variante explícita → NO asumas Doble 4cm; poné variante null, faltan_campos ["variante"], dudoso true, razon "grosor sin variante - preguntar Sin tela / Lienzo Profesional".
- "marco", "marcos" → categoria "tapacanto" (no bastidor). Ej: "2 marcos 60x80" → tapacanto 60x80.
- "acrílico verde viridiano chico" → acrilico Serie 2 60cc. "acrílico blanco grande" / "viridiano grande" → acrilico Serie 2 200cc. Si dice "viridiano" o "acrílico" sin tamaño claro, poné variante null y categoria acrilico.
- "rollo", "rollo de tela" → categoria "rollo de tela". Medida "2x5" literal en metros (NO convertir a cm). "rollo 2 x 5 metros" → medida "2x5". "rollo 1,5 x 5" → medida "1.5x5" faltante. Solo 2x5 tiene referencia limpia ($180k); otra medida de rollo → faltante y preguntar precio al dueño.
- "con tela" == "Lienzo Profesional". Solo preguntar Sin tela / Lienzo Profesional (no Lona Preparada) cuando pregunte por grosor.
NUNCA inventes variante si el sinónimo no está explícito salvo 4,5cm→Doble 4cm. Si dice "lo más ancho posible, onda caja, si pueden ser de 4-5cm ideal" → variante Doble 4cm con dudoso=false.
`
