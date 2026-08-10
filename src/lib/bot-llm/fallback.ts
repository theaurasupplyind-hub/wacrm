import { looksLikeExpense, parseExpense } from '@/lib/expenses/parse-expense'
import { looksLikeAttendance, parseAttendance } from '@/lib/attendance/parse-attendance'
import type { BotIntent, MissingField, MultiExpenseItem, UnifiedExtraction } from './types'

function empty(raw: string): UnifiedExtraction {
  return {
    intent: 'otro',
    confianza: 'baja',
    extractor_source: 'fallback',
    empleado: null,
    hora: null,
    estado: null,
    monto: null,
    categoria: null,
    tipo_gasto: null,
    saldo_pendiente: null,
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

// Separadores de una lista de gastos: coma, punto y coma, o "y"/"después"/"luego".
const MULTI_DELIMITER_RE = /(?:\s*[,;]\s*|\s+(?:y|despu[eé]s|luego)\s+)/i

// Si el texto matchea esto, es un split de pago (mismo gasto) o saldo — NO multi-expense.
const SPLIT_PAYMENT_HINT = /(?:por|en)\s+(?:transferencia|efectivo|transferi|transferí|debito|débito|credito|crédito|qr|mercado\s+pago|mp)\s+y/i

const STOPWORDS = new Set([
  'de', 'en', 'por', 'para', 'el', 'la', 'los', 'las', 'del', 'dia',
  'gasto', 'gastos', 'varios', 'lunes', 'martes', 'miercoles', 'miércoles',
  'jueves', 'viernes', 'sabado', 'sábado', 'domingo', 'hoy', 'ayer',
])

/** Intenta partir un texto en 2+ gastos independientes (conservador). */
function trySplitMultiExpense(text: string): MultiExpenseItem[] | null {
  if (/\bsaldo\b/i.test(text)) return null
  if (SPLIT_PAYMENT_HINT.test(text)) return null

  const parts = text
    .split(MULTI_DELIMITER_RE)
    .map(s => s.trim())
    .filter(Boolean)
  if (parts.length < 2) return null

  const items: MultiExpenseItem[] = []
  for (const part of parts) {
    const p = parseExpense(part)
    if (!p.amount || p.amount <= 0) return null

    let category = p.category
    if (!category) {
      // Derivar la categoría del resto del segmento (quita el monto y conectores).
      const rest = part
        .replace(/\$?\s*\d[\d.,]*\s*(mil|k|m)?(?![.\d])/gi, ' ')
        .replace(/[.:,]+/g, ' ')
        .trim()
      const words = rest.split(/\s+/).filter(w => w && !STOPWORDS.has(w.toLowerCase()))
      category = words.join(' ') || null
    }

    items.push({
      amount: p.amount,
      category,
      tipo_gasto: p.tipoGasto || null,
      provider: p.provider,
      employee: p.employee,
      payment_method: p.payment_method,
      description: p.description,
      date: p.date,
      raw: part,
    })
  }

  const provider = items.find(item => item.provider)?.provider || null
  if (provider) {
    for (let i = 0; i < items.length; i++) {
      if (!items[i].provider && items[i].tipo_gasto === 'pago') {
        items[i] = { ...items[i], provider }
      }
    }
  }

  return items.length >= 2 ? items : null
}

/**
 * Red de seguridad sin LLM: emula los gates regex actuales y los convierte en
 * una UnifiedExtraction. Confianza siempre 'baja' y dudoso según ambigüedad,
 * para que el webhook se comporte igual que con el fallback regex de hoy.
 */
export function fallbackExtract(text: string): UnifiedExtraction {
  const raw = (text || '').trim()
  if (!raw) return empty(raw)

  const multi = trySplitMultiExpense(raw)
  if (multi) {
    return {
      intent: 'multi_expense',
      confianza: 'media',
      extractor_source: 'fallback',
      empleado: null,
      hora: null,
      estado: null,
      monto: null,
      categoria: null,
      tipo_gasto: null,
      saldo_pendiente: null,
      proveedor: null,
      empleado_gasto: null,
      metodo_pago: null,
      fecha: null,
      multipleExpenses: multi,
      faltan_campos: [],
      dudoso: false,
      razon_duda: null,
      raw,
    }
  }

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
      extractor_source: 'fallback',
      empleado: null,
      hora: null,
      estado: null,
      monto: p.amount,
      categoria: p.category,
      tipo_gasto: p.tipoGasto || null,
      saldo_pendiente: p.saldoPendiente || null,
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
      extractor_source: 'fallback',
      empleado: a.employeeName,
      hora,
      estado,
      monto: null,
      categoria: null,
      tipo_gasto: null,
      saldo_pendiente: null,
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
