export interface ParsedAttendance {
  employeeName: string | null
  time: string | null
  date: string
  raw: string
  isAttendanceIntent: boolean
}

const ATTENDANCE_KEYWORDS = ['llego', 'llegó', 'llegue', 'llegada', 'llegadas']

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

function extractEmployeeName(text: string, keywordPos: number): string | null {
  const before = text.slice(0, keywordPos).trim()
  if (!before) return null
  const tokens = before.split(/\s+/)
  return tokens.join(' ') || null
}

export function parseAttendance(text: string): ParsedAttendance {
  const raw = text.trim()
  if (!raw) {
    return { employeeName: null, time: null, date: todayString(), raw, isAttendanceIntent: false }
  }

  const normalized = normalize(raw)
  const isAttendanceIntent = ATTENDANCE_KEYWORDS.some(k => normalized.includes(k))
  if (!isAttendanceIntent) {
    return { employeeName: null, time: null, date: todayString(), raw, isAttendanceIntent: false }
  }

  let remaining = raw
  let date: string | null = null
  let parsedDate = extractDate(remaining)
  date = parsedDate.date
  remaining = parsedDate.remaining

  let time: string | null = null
  let parsedTime = extractTime(remaining)
  time = parsedTime.time
  remaining = parsedTime.remaining

  const keywordRegex = /\b(llego|llegó|llegue|llegada|llegadas)\b/i
  const kwMatch = remaining.match(keywordRegex)
  let employeeName: string | null = null
  if (kwMatch) {
    employeeName = extractEmployeeName(remaining, kwMatch.index!)
  }

  return {
    employeeName,
    time: time || '00:00',
    date: date || todayString(),
    raw,
    isAttendanceIntent,
  }
}

export function looksLikeAttendance(text: string): boolean {
  const normalized = normalize(text)
  return ATTENDANCE_KEYWORDS.some(k => normalized.includes(k))
}
