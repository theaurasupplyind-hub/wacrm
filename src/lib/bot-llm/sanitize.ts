/**
 * Sanitización de campos extraídos por el LLM: números (formatos AR/US y
 * sufijos "mil"/"k"/"m"), horas y fechas. Todo falla "suave" devolviendo
 * null en lugar de romper el parseo.
 */

export function extractJson(raw: string): string | null {
  const match = raw.match(/\{[\s\S]*\}/)
  return match ? match[0] : null
}

function parseNumberCore(s: string): number | null {
  let cleaned = s.trim()
  if (!cleaned) return null

  // Formatos: 18.000,50 / 18000,50 / 18,000.50 / 18000
  if (cleaned.includes(',') && cleaned.includes('.')) {
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      // 18.000,50 → AR
      cleaned = cleaned.replace(/\./g, '').replace(',', '.')
    } else {
      // 18,000.50 → US
      cleaned = cleaned.replace(/,/g, '')
    }
  } else if (cleaned.includes(',')) {
    const parts = cleaned.split(',')
    if (parts.length === 2 && parts[1].length <= 2) {
      cleaned = cleaned.replace(',', '.')
    } else {
      cleaned = cleaned.replace(/,/g, '')
    }
  } else if (cleaned.includes('.')) {
    const parts = cleaned.split('.')
    if (parts.length === 2 && parts[1].length <= 2) {
      // decimal
    } else {
      cleaned = cleaned.replace(/\./g, '')
    }
  }

  const n = parseFloat(cleaned)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** "18 mil" / "18k" / "18 m" → 18000; "$18.000,00" → 18000; "18,000.00" → 18000 */
export function parseMontoSafe(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 ? value : null
  }
  if (typeof value !== 'string') return null

  const s = value.trim().replace(/[$]/g, '')
  if (!s) return null

  const suffixMatch = s.match(/^(\d[\d.,]*)\s*(mil|k|m)$/i)
  if (suffixMatch) {
    const base = parseNumberCore(suffixMatch[1])
    if (base === null) return null
    const suffix = suffixMatch[2].toLowerCase()
    if (suffix === 'mil' || suffix === 'k' || suffix === 'm') {
      return base * 1000
    }
    return base
  }

  return parseNumberCore(s)
}

/** "a las 8:30", "8:30", "8.30", "8,30", "830", "17" → "08:30" / "17:00" */
export function normalizeTime(input: unknown): string | null {
  if (typeof input !== 'string') return null
  let s = input.trim().toLowerCase()
  if (!s) return null

  // "a las 8:30" / "a 8:30"
  s = s.replace(/^(a\s+las|a)\s+/i, '').trim()

  // "8.30" / "8,30" → "8:30"
  s = s.replace(/[.,]/g, ':')

  // "830" → 8:30, "1730" → 17:30
  if (/^\d{3,4}$/.test(s)) {
    if (s.length === 3) s = s.slice(0, 1) + ':' + s.slice(1)
    else if (s.length === 4) s = s.slice(0, 2) + ':' + s.slice(2)
  }

  const hhmm = s.match(/^(\d{1,2}):(\d{2})$/)
  if (hhmm) {
    const h = parseInt(hhmm[1], 10)
    const min = parseInt(hhmm[2], 10)
    if (h < 0 || h > 23 || min < 0 || min > 59) return null
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
  }

  // Hora suelta: "17", "8"
  const bare = s.match(/^(\d{1,2})$/)
  if (bare) {
    const h = parseInt(bare[1], 10)
    if (h >= 0 && h <= 23) return `${String(h).padStart(2, '0')}:00`
  }

  return null
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function daysAgoIso(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

/** "hoy"/"ayer"/"anteayer"/"15/7/26"/"2026-07-15" → "YYYY-MM-DD" */
export function normalizeDate(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const s = input.trim()
  if (!s) return null

  const lower = s.toLowerCase()
  if (lower === 'hoy') return todayIso()
  if (lower === 'ayer') return daysAgoIso(1)
  if (lower === 'anteayer') return daysAgoIso(2)

  // "2026-07-15"
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (m) {
    const y = m[1]
    const mo = m[2].padStart(2, '0')
    const d = m[3].padStart(2, '0')
    return `${y}-${mo}-${d}`
  }

  // "15/7/26", "15-7-26", "15/07/2026"
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/)
  if (m) {
    const d = m[1].padStart(2, '0')
    const mo = m[2].padStart(2, '0')
    const y = m[3].length === 2 ? '20' + m[3] : m[3]
    return `${y}-${mo}-${d}`
  }

  return null
}
