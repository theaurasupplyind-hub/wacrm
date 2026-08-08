export type AttendanceStatusType = 'arrival' | 'departure' | 'vacaciones' | 'licencia' | 'ausente'

export interface ParsedAttendance {
  employeeName: string | null
  time: string | null
  date: string
  raw: string
  isAttendanceIntent: boolean
  statusType: AttendanceStatusType
}

// Keywords se usan en dos lugares: la detección corre sobre el texto
// normalizado (sin acentos), el regex de extracción del nombre corre sobre
// el texto crudo. Por eso conviene incluir ambas formas (acentuada y no).
const ARRIVAL_KEYWORDS = ['llego', 'llegó', 'llegue', 'llegada', 'llegadas']

const DEPARTURE_KEYWORDS = [
  'salgo',
  'sale',
  'sali',
  'salí',
  'salida',
  'me voy',
  'me fui',
  'termine',
  'terminé',
  'me retiro',
  'chau',
  'se fue',
]

const STATUS_KEYWORDS: Record<string, AttendanceStatusType> = {
  vacaciones: 'vacaciones',
  vacacion: 'vacaciones',
  vaca: 'vacaciones',
  licencia: 'licencia',
  lic: 'licencia',
  ausente: 'ausente',
  aus: 'ausente',
  falta: 'ausente',
  falto: 'ausente',
}

const FILLER_WORDS = new Set([
  'esta', 'está', 'estas', 'están',
  'de', 'del',
  'tiene', 'tienen', 'tenga', 'tengas',
  'se', 'fue', 'son', 'va', 'van',
  'ir', 'en', 'con', 'por', 'para', 'anda',
])

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s:]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function todayString(): string {
  return new Date().toISOString().slice(0, 10)
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractTime(text: string): { time: string | null; remaining: string } {
  const patterns = [
    /a\s+las\s+(\d{1,2})[:.](\d{2})/i,
    /a\s+las\s+(\d{1,2})\s*$/i,
    /(\d{1,2})[:.](\d{2})/,
  ]
  for (const pat of patterns) {
    const m = text.match(pat)
    if (m) {
      if (m[2] !== undefined) {
        const h = m[1].padStart(2, '0')
        const min = m[2]
        if (parseInt(min) < 60) {
          return { time: `${h}:${min}`, remaining: text.replace(m[0], ' ').replace(/\s+/g, ' ').trim() }
        }
      } else {
        const h = m[1].padStart(2, '0')
        return { time: `${h}:00`, remaining: text.replace(m[0], ' ').replace(/\s+/g, ' ').trim() }
      }
    }
  }
  return { time: null, remaining: text }
}

function extractDate(text: string): { date: string | null; remaining: string } {
  const patterns = [
    /(?:dia|el|del)\s+(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/i,
    /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/,
  ]
  for (const pat of patterns) {
    const m = text.match(pat)
    if (m) {
      const d = m[1].padStart(2, '0')
      const mo = m[2].padStart(2, '0')
      let y = m[3]
      if (!y) {
        y = String(new Date().getFullYear())
      } else {
        y = y.length === 2 ? '20' + y : y
      }
      const dateStr = `${y}-${mo}-${d}`
      return { date: dateStr, remaining: text.replace(m[0], ' ').replace(/\s+/g, ' ').trim() }
    }
  }
  return { date: null, remaining: text }
}

/**
 * Captura el nombre del empleado antes o después de la keyword de asistencia.
 * Ej: "juan llegó a las 8:30" (antes), "llegó juan" (después),
 *     "se fue juan" (después), "juan se fue" (antes).
 */
function extractEmployeeName(text: string, keywordPos: number, keywordLen: number): string | null {
  const candidates: string[] = []
  const before = text.slice(0, keywordPos).trim()
  if (before) candidates.push(before)

  const after = text.slice(keywordPos + keywordLen).trim()
  if (after) candidates.push(after)

  for (const candidate of candidates) {
    const tokens = candidate.split(/\s+/).filter(t => !FILLER_WORDS.has(t.toLowerCase()))
    if (tokens.length > 0) {
      return tokens.join(' ')
    }
  }
  return null
}

function extractStatusEmployeeName(text: string, keywordPos: number): string | null {
  const before = text.slice(0, keywordPos).trim()
  if (!before) return null
  const tokens = before.split(/\s+/)
  const filtered = tokens.filter(t => !FILLER_WORDS.has(t.toLowerCase()))
  return filtered.join(' ') || null
}

// Las keywords pueden contener acentos (ej: "llegó"), donde `\b` no genera
// límite de palabra (JS \w no cubre caracteres acentuados). Usamos grupos de
// límite explícitos (inicio/fin de texto o separador) para que el match
// funcione sobre el texto crudo. El grupo 1 captura el separador inicial,
// el grupo 2 la keyword.
function buildIntentRegex(): RegExp {
  const words = [...ARRIVAL_KEYWORDS, ...DEPARTURE_KEYWORDS].sort((a, b) => b.length - a.length)
  return new RegExp('(^|[\\s.,;:!?¿¡])(' + words.map(escapeRegex).join('|') + ')(?=[\\s.,;:!?¿¡]|$)', 'i')
}

export function parseAttendance(text: string): ParsedAttendance {
  const raw = text.trim()
  if (!raw) {
    return { employeeName: null, time: null, date: todayString(), raw, isAttendanceIntent: false, statusType: 'arrival' }
  }

  const normalized = normalize(raw)
  const isArrival = ARRIVAL_KEYWORDS.some(k => normalized.includes(k))
  const isDeparture = DEPARTURE_KEYWORDS.some(k => normalized.includes(k))

  const statusEntry = Object.entries(STATUS_KEYWORDS).find(([kw]) => normalized.includes(kw))
  const isStatus = !!statusEntry

  if (!isArrival && !isDeparture && !isStatus) {
    return { employeeName: null, time: null, date: todayString(), raw, isAttendanceIntent: false, statusType: 'arrival' }
  }

  let remaining = raw
  let date: string | null = null
  const parsedDate = extractDate(remaining)
  date = parsedDate.date
  remaining = parsedDate.remaining

  if (isArrival || isDeparture) {
    let time: string | null = null
    const parsedTime = extractTime(remaining)
    time = parsedTime.time
    remaining = parsedTime.remaining

    const kwMatch = remaining.match(buildIntentRegex())
    let employeeName: string | null = null
    if (kwMatch) {
      const boundaryLen = kwMatch[1] ? kwMatch[1].length : 0
      const kwStart = kwMatch.index! + boundaryLen
      employeeName = extractEmployeeName(remaining, kwStart, kwMatch[2].length)
    }

    return {
      employeeName,
      time: time || '00:00',
      date: date || todayString(),
      raw,
      isAttendanceIntent: true,
      statusType: isDeparture ? 'departure' : 'arrival',
    }
  }

  if (isStatus) {
    const [statusKeyword, statusType] = statusEntry!
    const escaped = statusKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp('\\b' + escaped + '\\b', 'i')
    const kwMatch = remaining.match(regex)
    let employeeName: string | null = null
    if (kwMatch) {
      employeeName = extractStatusEmployeeName(remaining, kwMatch.index!)
    }

    return {
      employeeName,
      time: null,
      date: date || todayString(),
      raw,
      isAttendanceIntent: true,
      statusType,
    }
  }

  return { employeeName: null, time: null, date: todayString(), raw, isAttendanceIntent: false, statusType: 'arrival' }
}

// "se fue la luz", "se fue la corriente", etc. NO son salidas del trabajo.
// Solo "se fue [persona]" con nombre cuenta como salida.
const INANIMATE_FUE_PATTERNS = [
  /\bse\s+fue\s+(la\s+|el\s+)?(luz|corriente|electricidad|energia|bateria|internet|wifi|senal)\b/,
]

export function looksLikeAttendance(text: string): boolean {
  const normalized = normalize(text)
  if (ARRIVAL_KEYWORDS.some(k => normalized.includes(k))) return true
  if (DEPARTURE_KEYWORDS.some(k => normalized.includes(k))) {
    if (INANIMATE_FUE_PATTERNS.some(p => p.test(normalized))) return false
    return true
  }
  return Object.keys(STATUS_KEYWORDS).some(k => normalized.includes(k))
}
