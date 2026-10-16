function digits(value: string | null | undefined): string {
  return (value || '').replace(/\D/g, '')
}

export function isSenderPhone(value: string | null | undefined, senderPhone: string | null | undefined): boolean {
  const candidate = digits(value)
  const sender = digits(senderPhone)
  if (candidate.length < 7 || sender.length < 7) return false
  if (candidate === sender) return true
  // Meta may provide the Argentine country/mobile prefix while FacBal stores
  // the same line locally (or vice versa); compare the national-number suffix.
  return candidate.length >= 10 && sender.length >= 10 && candidate.slice(-10) === sender.slice(-10)
}

/** Reject phone-only/phone-as-label strings where a customer name is expected. */
export function isPhoneLikeClientName(
  value: string | null | undefined,
  senderPhone?: string | null,
): boolean {
  const name = (value || '').trim()
  if (!name) return false
  if (isSenderPhone(name, senderPhone)) return true

  const compact = name.replace(/[\s().+\-]/g, '')
  if (/^\d{7,}$/.test(compact)) return true

  // Historical imports sometimes stored a phone number under a generic label.
  if (/^cliente\s*\+?[\d\s().-]{7,}$/i.test(name)) return true
  const withoutGenericLabel = name.replace(/^cliente\s*/i, '').trim()
  return isSenderPhone(withoutGenericLabel, senderPhone)
}

export function isSenderPhoneCandidate(
  candidate: { nombre: string; telefono?: string | null },
  senderPhone?: string | null,
): boolean {
  // Don't suppress a legitimately named client just because their phone field
  // happens to match the internal sender. Only phone-as-name records are invalid.
  const genericName = /^cliente(?:\s+\d+)?$/i.test(candidate.nombre.trim())
  return isPhoneLikeClientName(candidate.nombre, senderPhone) ||
    (genericName && isSenderPhone(candidate.telefono, senderPhone))
}

const NOT_A_CLIENT_NAME_RE =
  /\b(?:presupuesto|cotizaci[oó]n|prueba|creando|armando|estabas|estaba|cancelar|olvidar|precio|disponible|tienen|cu[aá]nto|quiero|quer[ií]a|cambia|cambiar|cambi[aá]|corrige|corregir|correg[ií]|agrega|agregar|saca|sacar|quita|quitar|medida|reemplaza|mejor|hola|gracias|otro|otra|ninguno|ninguna|buenos?\s+d[ií]as|buenas?\s+(?:tardes|noches))\b/i

// Saludo seguido de un nombre ("Hola Jorge", "Buenas tardes Ana"): ese nombre es
// el DESTINATARIO del saludo, no el cliente del presupuesto.
const GREETING_NAME_RE =
  /\b(?:hola+|buenos\s+d[ií]as|buenas\s+(?:tardes|noches)|buen[oa]s?|qu[eé]\s+tal)[,\s]+([A-Za-zÁÉÍÓÚÑáéíóúñ]{2,})\b/i

function nameKey(value: string): string {
  return (value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
}

/** Destinatario explícito del pedido ("para Juan", "a Joaquín"). */
export function explicitClientFromText(text: string): string | null {
  const m = (text || '').match(
    /\b(?:para|a)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?)/,
  )
  return m ? m[1].trim() : null
}

/**
 * En "Hola Jorge tengo 4 pinturas...", "Jorge" es a quién saluda el mensaje, no
 * el cliente. Devuelve true cuando `value` sólo aparece como nombre del saludo
 * (y no como destinatario explícito "para Jorge").
 */
export function isGreetingRecipientName(value: string | null | undefined, text: string): boolean {
  const name = nameKey(value || '')
  if (!name) return false
  const m = (text || '').match(GREETING_NAME_RE)
  if (!m) return false
  if (nameKey(m[1]) !== name) return false
  const explicit = explicitClientFromText(text)
  return !(explicit && nameKey(explicit) === name)
}

/**
 * A pending customer-name slot must not absorb a sentence about the task.
 * Returns a cleaned name only for plausible short name-like replies.
 */
export function normalizeClientNameReply(
  value: string | null | undefined,
  senderPhone?: string | null,
): string | null {
  const text = (value || '').trim()
  if (!text || isPhoneLikeClientName(text, senderPhone) || NOT_A_CLIENT_NAME_RE.test(text)) return null
  if (/[?¿!¡]/.test(text) || text.split(/\s+/).length > 6) return null

  const prefixed = text.match(/^(?:a nombre de|el cliente es|cliente:)\s*(.+)$/i)
  const name = (prefixed?.[1] || text).trim()
  if (!/[a-záéíóúñ]/i.test(name)) return null
  return name
}

// ── Matching de candidatos de cliente (nombre con tolerancia a typos) ──

const NAME_STOPWORDS = new Set([
  'de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'y', 'e', 'a', 'en', 'con', 'para', 'al',
])

function candidateTokens(value: string): string[] {
  return nameKey(value)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !NAME_STOPWORDS.has(t))
}

function editDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  for (let i = 1; i <= m; i++) {
    const curr: number[] = [i]
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    prev = curr
  }
  return prev[n]
}

/** Similitud entre dos tokens: 1 exacto, ~0.9 prefijo, o 1 - distancia/máx. */
function tokenSimilarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))) return 0.9
  const max = Math.max(a.length, b.length)
  if (max === 0) return 0
  return 1 - editDistance(a, b) / max
}

/**
 * Elige un candidato de `clienteCandidatos` a partir del texto del usuario
 * (tolerando 1-2 letras de typo, ej. "Pachecho" ↔ "Cesar Pacheco"). Devuelve el
 * candidato SOLO si gana de forma clara; si no, null (se trata como nombre
 * nuevo y se re-consulta FacBal).
 */
export function matchClienteCandidato<T extends { nombre: string }>(
  text: string,
  candidates: T[],
): T | null {
  const input = candidateTokens(text)
  if (input.length === 0 || candidates.length === 0) return null

  const scored = candidates.map((candidate) => {
    const toks = candidateTokens(candidate.nombre)
    if (toks.length === 0) return { candidate, score: 0, strong: false }
    let sum = 0
    let strong = false
    for (const it of input) {
      let best = 0
      for (const ct of toks) {
        const s = tokenSimilarity(it, ct)
        if (s > best) best = s
      }
      if (best >= 0.85) strong = true
      sum += best
    }
    return { candidate, score: sum / input.length, strong }
  })

  scored.sort((a, b) => b.score - a.score)
  const top = scored[0]
  const second = scored[1]
  if (!top.strong || top.score < 0.82) return null
  // Empate casi exacto entre dos candidatos → ambiguo, que elija el usuario.
  if (second && top.score - second.score < 0.12 && top.score < 0.999) return null
  return top.candidate
}
