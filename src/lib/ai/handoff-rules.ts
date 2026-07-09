const HARD_HANDOFF_PATTERNS = [
  /\b(direcci[oó]n|domicilio)\b/i,
  /\b(entrega|env[ií]o|retiro|buscar|pasar a buscar)\b/i,
  /\b(descuento|rebaja|mejor precio)\b/i,
  /\b(reclamo|queja|me fall[oó]|me vino mal|defectuoso|roto)\b/i,
  /\b(s[aá]bado|domingo|lunes|martes|mi[eé]rcoles|jueves|viernes|horario)\b/i,
  /\b(pago|transferencia|efectivo|mercado pago|tarjeta)\b/i,
  /\b(hoy|ma[nñ]ana|pasado)\b/i,
]

export function shouldHardHandoff(text: string): string | null {
  for (const pattern of HARD_HANDOFF_PATTERNS) {
    if (pattern.test(text)) {
      return pattern.source
    }
  }
  return null
}

export function shouldHandoff(args: {
  llmResponse?: string
  intent?: string
  cart?: { items?: unknown[] } | null
}): { handoff: boolean; reason?: string } {
  if (args.llmResponse?.includes('[[HANDOFF]]')) {
    return { handoff: true, reason: 'LLM sentinel' }
  }

  if (args.intent === 'confirm_order' && !args.cart?.items?.length) {
    return { handoff: true, reason: 'confirm_order without active cart' }
  }

  return { handoff: false }
}
