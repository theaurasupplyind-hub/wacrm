import { looksLikeExpense, parseExpense } from '@/lib/expenses/parse-expense'
import { looksLikeAttendance, parseAttendance } from '@/lib/attendance/parse-attendance'
import type { BotIntent, MissingField, UnifiedExtraction } from './types'

function empty(raw: string): UnifiedExtraction {
  return {
    intent: 'otro',
    confianza: 'baja',
    empleado: null,
    hora: null,
    estado: null,
    monto: null,
    categoria: null,
    proveedor: null,
    empleado_gasto: null,
    metodo_pago: null,
    fecha: null,
    faltan_campos: [],
    dudoso: false,
    razon_duda: null,
    raw,
  }
}

/**
 * Red de seguridad sin LLM: emula los gates regex actuales y los convierte en
 * una UnifiedExtraction. Confianza siempre 'baja' y dudoso según ambigüedad,
 * para que el webhook se comporte igual que con el fallback regex de hoy.
 */
export function fallbackExtract(text: string): UnifiedExtraction {
  const raw = (text || '').trim()
  if (!raw) return empty(raw)

  if (looksLikeExpense(raw)) {
    const p = parseExpense(raw)
    const faltan: MissingField[] = []
    if (!p.amount || p.amount <= 0) faltan.push('monto')
    if (!p.category) faltan.push('categoria')
    if (!p.provider && !p.employee) faltan.push('proveedor')

    let razon: string | null = null
    if (!p.amount || p.amount <= 0) {
      razon = 'No se detectó el monto del gasto.'
    } else if (p.amountAmbiguous) {
      razon = 'El monto no quedó anclado a una palabra de pago; puede ser ambiguo.'
    }

    return {
      intent: 'gasto',
      confianza: 'baja',
      empleado: null,
      hora: null,
      estado: null,
      monto: p.amount,
      categoria: p.category,
      proveedor: p.provider,
      empleado_gasto: p.employee,
      metodo_pago: p.payment_method,
      fecha: p.date,
      faltan_campos: faltan,
      dudoso: !!razon,
      razon_duda: razon,
      raw,
    }
  }

  if (looksLikeAttendance(raw)) {
    const a = parseAttendance(raw)
    let intent: BotIntent
    switch (a.statusType) {
      case 'arrival':
        intent = 'asistencia_llegada'
        break
      case 'departure':
        intent = 'asistencia_salida'
        break
      default:
        intent = 'asistencia_estado'
        break
    }

    // '00:00' es el default del parser cuando no hay hora → tratarlo como faltante.
    const hora = a.time && a.time !== '00:00' ? a.time : null
    const needsTime = a.statusType === 'arrival' || a.statusType === 'departure'

    const faltan: MissingField[] = []
    if (!a.employeeName) faltan.push('empleado')
    if (needsTime && !hora) faltan.push('hora')

    const estado =
      a.statusType === 'vacaciones' || a.statusType === 'licencia' || a.statusType === 'ausente'
        ? a.statusType
        : null

    const dudoso = !a.employeeName || (needsTime && !hora)
    const razon = dudoso
      ? !a.employeeName
        ? 'Falta identificar al empleado.'
        : 'Falta la hora de llegada o salida.'
      : null

    return {
      intent,
      confianza: 'baja',
      empleado: a.employeeName,
      hora,
      estado,
      monto: null,
      categoria: null,
      proveedor: null,
      empleado_gasto: null,
      metodo_pago: null,
      fecha: a.date,
      faltan_campos: faltan,
      dudoso,
      razon_duda: razon,
      raw,
    }
  }

  return empty(raw)
}
