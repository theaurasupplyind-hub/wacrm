// Parseo y serialización de fechas de entrega.
//
// backend_gal guarda `fecha_entrega` como JSON `{"desde","hasta","extras"}`
// con fechas en `D/M/AAAA` sin padding (ver `normalize_fecha_entrega` en
// backend_gal/main.py). Acá interpretamos lenguaje natural acotado
// ("el viernes", "mañana", "15/11", "del 10 al 12") y producimos ese formato.

export interface DeliveryDate {
  desde: string
  hasta: string
  extras: string[]
}

const WEEKDAYS: Record<string, number> = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
}

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

/** Fecha D/M/AAAA sin padding (como espera backend_gal). */
export function formatDMY(d: Date): string {
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`
}

function atMidnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

function single(d: Date): DeliveryDate {
  const s = formatDMY(d)
  return { desde: s, hasta: s, extras: [] }
}

/** Fecha explícita d/m o d/m/aaaa dentro del texto (o null). */
function explicitDate(text: string, now: Date): Date | null {
  const m = text.match(/\b(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?\b/)
  if (!m) return null
  const day = parseInt(m[1], 10)
  const month = parseInt(m[2], 10)
  let year = m[3] ? parseInt(m[3], 10) : now.getFullYear()
  if (year < 100) year += 2000
  if (day < 1 || day > 31 || month < 1 || month > 12) return null
  const d = new Date(year, month - 1, day)
  // Sin año y ya pasó → asumimos el próximo año.
  if (!m[3] && d < atMidnight(now)) d.setFullYear(year + 1)
  return d
}

const SKIP_RE = /^(no|sin fecha|nada|ninguna|despues|despu[eé]s|luego|omitir|saltear|salteo|paso)$/i

/** True si el usuario dijo que no quiere fecha. */
export function isSkipDate(text: string): boolean {
  return SKIP_RE.test(stripAccents((text || '').trim().toLowerCase()))
}

/**
 * Interpreta el texto a una fecha (o rango) de entrega.
 * Devuelve null si no se entiende.
 */
export function parseDeliveryDate(text: string, now = new Date()): DeliveryDate | null {
  const t = stripAccents((text || '').trim().toLowerCase())
  if (!t) return null

  // Rango explícito: "del 10/11 al 15/11", "10/11 a 15/11".
  const range = t.match(
    /(\d{1,2}[/\-.]\d{1,2}(?:[/\-.]\d{2,4})?)\s*(?:al|a|hasta)\s*(\d{1,2}[/\-.]\d{1,2}(?:[/\-.]\d{2,4})?)/,
  )
  if (range) {
    const desde = explicitDate(range[1], now)
    const hasta = explicitDate(range[2], now)
    if (desde && hasta) return { desde: formatDMY(desde), hasta: formatDMY(hasta), extras: [] }
  }

  const singleDate = explicitDate(t, now)
  if (singleDate) return single(singleDate)

  const base = atMidnight(now)
  if (/\bhoy\b/.test(t)) return single(base)
  if (/\bpasado\s+manana\b/.test(t)) return single(addDays(base, 2))
  if (/\bmanana\b/.test(t)) return single(addDays(base, 1))
  const inDays = t.match(/\ben\s+(\d{1,3})\s+dias?\b/)
  if (inDays) return single(addDays(base, parseInt(inDays[1], 10)))
  if (/\b(?:la\s+)?(?:semana\s+que\s+viene|proxima\s+semana|semana\s+proxima)\b/.test(t)) {
    return single(addDays(base, 7))
  }

  for (const [name, dow] of Object.entries(WEEKDAYS)) {
    if (new RegExp(`\\b${name}\\b`).test(t)) {
      const delta = (dow - base.getDay() + 7) % 7
      return single(addDays(base, delta))
    }
  }

  return null
}

/** Serializa al JSON que espera backend_gal. */
export function serializeFechaEntrega(fecha: DeliveryDate): string {
  return JSON.stringify({ desde: fecha.desde, hasta: fecha.hasta, extras: fecha.extras })
}

/** Texto corto para mostrar en el resumen ("15/11" o "15/11 al 20/11"). */
export function formatFechaEntregaDisplay(json: string | undefined | null): string {
  if (!json) return ''
  try {
    const o = JSON.parse(json) as { desde?: string; hasta?: string }
    if (!o.desde) return ''
    if (o.hasta && o.hasta !== o.desde) return `${o.desde} al ${o.hasta}`
    return o.desde
  } catch {
    return json
  }
}
