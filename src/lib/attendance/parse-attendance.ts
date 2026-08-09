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

function to24h(h: number, meridiem?: 'am' | 'pm'): number {
  if (!meridiem) return h
  if (meridiem === 'pm' && h !== 12) return h + 12
  if (meridiem === 'am' && h === 12) return 0
  return h
}

function extractTime(text: string): { time: string | null; remaining: string } {
  const patterns: { re: RegExp; h: number; m?: number; merid?: number }[] = [
    // "a las 11:30", "a las 11:30 am"
    { re: /a\s+las\s+(\d{1,2})[:.](\d{2})\s*(a\.?m\.?|p\.?m\.?)?/i, h: 1, m: 2, merid: 3 },
    // "a las 11", "a las 11am", "a las 8 pm"
    { re: /a\s+las\s+(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)?\b/i, h: 1, merid: 2 },
    // "llegó 11:30", "11:30 am"
    { re: /(\d{1,2})[:.](\d{2})\s*(a\.?m\.?|p\.?m\.?)?/, h: 1, m: 2, merid: 3 },
    // "llegó 11am", "salgo 3 pm"
    { re: /(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)\b/i, h: 1, merid: 2 },
  ]
  for (const pat of patterns) {
    const match = text.match(pat.re)
    if (!match) continue
    const meridRaw = pat.merid !== undefined ? match[pat.merid] : undefined
    const lower = (meridRaw || '').toLowerCase()
    const meridiem = lower.startsWith('p') ? 'pm' as const : lower.startsWith('a') ? 'am' as const : undefined
    const h = to24h(parseInt(match[pat.h], 10), meridiem)
    if (h > 23) continue
    if (pat.m !== undefined && match[pat.m] !== undefined && /^\d+$/.test(match[pat.m])) {
      const min = parseInt(match[pat.m], 10)
      if (min > 59) continue
      return { time: `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`, remaining: text.replace(match[0], ' ').replace(/\s+/g, ' ').trim() }
    }
    return { time: `${String(h).padStart(2, '0')}:00`, remaining: text.replace(match[0], ' ').replace(/\s+/g, ' ').trim() }
  }
  return { time: null, remaining: text }
}

const MONTH_NAMES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10,
  noviembre: 11, diciembre: 12,
}

const WEEKDAY_IDX: Record<string, number> = {
  domingo: 0, lunes: 1, martes: 2, miercoles: 3, miércoles: 3,
  jueves: 4, viernes: 5, sabado: 6, sábado: 6,
}

const MONTH_RE = 'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre'
const WEEKDAY_RE = 'domingo|lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado'

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function toIso(year: number | string, month: number, day: number): string {
  let y = String(year)
  if (/^\d{2}$/.test(y)) y = '20' + y
  return `${y}-${pad2(month)}-${pad2(day)}`
}

/** El día de semana más reciente (≤ hoy). Si hoy es ese día, devuelve hoy. */
function lastWeekdayIso(idx: number): string {
  const now = new Date()
  const diff = (now.getDay() - idx + 7) % 7
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff)
  return toIso(d.getFullYear(), d.getMonth() + 1, d.getDate())
}

function relativeIso(kind: string): string {
  const now = new Date()
  const n = kind === 'hoy' ? 0 : kind === 'ayer' ? 1 : 2
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - n)
  return toIso(d.getFullYear(), d.getMonth() + 1, d.getDate())
}

/**
 * Extrae la fecha de un texto de asistencia. Prioridad:
 *   1) Fecha exacta (día + mes): "09 del 08", "9 de agosto", "09/08", "9/8/2026".
 *      Si además dice un día de semana ("el lunes 09 del 08"), gana la fecha
 *      exacta y corrige el día de semana aunque no coincidan.
 *   2) Día de semana ("el lunes", "el último lunes") → el más reciente (≤ hoy).
 *   3) Relativos: "hoy", "ayer", "anteayer".
 * Todas las menciones de fecha se quitan del texto (para no ensuciar la
 * extracción de nombre/hora), aunque la usada sea de menor prioridad.
 */
function extractDate(text: string): { date: string | null; remaining: string } {
  let remaining = text
  let explicit: string | null = null
  let weekday: string | null = null
  let relative: string | null = null

  const stripSpan = (span: string) => {
    remaining = remaining.replace(span, ' ').replace(/\s+/g, ' ').trim()
  }

  const explicitPatterns: { re: RegExp; build: (m: RegExpMatchArray) => string | null }[] = [
    {
      // "09 del 08", "9 del 8 del 25", "09 del 08 de 2026"
      re: /(?<!las )(\d{1,2})\s+del\s+(\d{1,2})(?:\s+(?:de|del)\s+(\d{2,4}))?/i,
      build: (m) => {
        const mo = parseInt(m[2], 10)
        if (mo < 1 || mo > 12) return null
        return toIso(m[3] || new Date().getFullYear(), mo, parseInt(m[1], 10))
      },
    },
    {
      // "9 de agosto", "9 de Agosto de 2025", "9 de agosto del 25"
      re: new RegExp(`(?<!las )(\\d{1,2})\\s+de\\s+(${MONTH_RE})(?:\\s+(?:de|del)\\s+(\\d{2,4}))?`, 'i'),
      build: (m) => {
        const mo = MONTH_NAMES[m[2].toLowerCase()]
        if (!mo) return null
        return toIso(m[3] || new Date().getFullYear(), mo, parseInt(m[1], 10))
      },
    },
    {
      // "el 09/08", "día 9-8", "del 09/08"
      re: /(?:dia|el|del)\s+(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/i,
      build: (m) => {
        const mo = parseInt(m[2], 10)
        if (mo < 1 || mo > 12) return null
        return toIso(m[3] || new Date().getFullYear(), mo, parseInt(m[1], 10))
      },
    },
    {
      // "09/08/2026", "9-8-25"
      re: /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/,
      build: (m) => {
        const mo = parseInt(m[2], 10)
        if (mo < 1 || mo > 12) return null
        return toIso(m[3], mo, parseInt(m[1], 10))
      },
    },
  ]

  for (const { re, build } of explicitPatterns) {
    let m = remaining.match(re)
    while (m) {
      if (!explicit) explicit = build(m)
      stripSpan(m[0])
      m = remaining.match(re)
    }
  }

  const wdRe = new RegExp(`(?:el\\s+|dia\\s+|día\\s+|ultimo\\s+|último\\s+)?(${WEEKDAY_RE})\\b`, 'i')
  let wdM = remaining.match(wdRe)
  while (wdM) {
    if (!weekday) weekday = lastWeekdayIso(WEEKDAY_IDX[wdM[1].toLowerCase()])
    stripSpan(wdM[0])
    wdM = remaining.match(wdRe)
  }

  const relRe = /\b(hoy|ayer|anteayer)\b/i
  let relM = remaining.match(relRe)
  while (relM) {
    if (!relative) relative = relativeIso(relM[1].toLowerCase())
    stripSpan(relM[0])
    relM = remaining.match(relRe)
  }

  return { date: explicit || weekday || relative, remaining }
}

/** Versión pública de extractDate: devuelve solo la fecha ISO (o null). */
export function extractAttendanceDate(text: string): string | null {
  return extractDate(text).date
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
