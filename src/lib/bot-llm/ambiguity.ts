import type { BotIntent, UnifiedExtraction } from './types'

/**
 * Bot conversacional ante ambigüedad: cuando el intent no es firme pero hay
 * 2–3 hipótesis concretas, se pregunta con botones en vez de adivinar.
 * Si no hay hipótesis concretas (saludos, charla), devuelve null y el mensaje
 * sigue al assistant como hoy — nunca se interroga por un "hola".
 */

export interface ClarifyOption {
  /** id estable del botón (también acepta letra A/B/C o título por texto) */
  id: string
  title: string
  intent: BotIntent
}

export interface Ambiguity {
  kind: 'pago' | 'baja_confianza'
  question: string
  options: ClarifyOption[]
}

/** ¿El texto tiene forma de pago de cliente? (Nombre + verbo en 3ª persona) */
const PAYMENT_SHAPE_RE =
  /^\s*[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){0,2}\s+(pag[oó]|paga|pagan|pagaron|abon[oó]|abona|abonan|abonaron)\b/i

const PAYMENT_EXCLUSIONS_RE = /\b(le|les|sueldo|sueldos|salario|adelanto|a\s+cuenta)\b/i

function norm(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim()
}

/**
 * Detecta si corresponde preguntar antes de despachar.
 * - Voucher firme (intent voucher + alta, o corrección determinística ya
 *   aplicada) → null, va directo.
 * - Forma de pago pero intent distinto / confianza no alta / dudoso →
 *   pregunta gasto↔voucher.
 * - Confianza baja con hipótesis concretas (monto+proveedor, empleado+hora)
 *   → pregunta genérica con esas opciones.
 */
export function detectAmbiguity(
  extraction: UnifiedExtraction,
  rawText: string,
): Ambiguity | null {
  const text = (rawText || '').trim()
  if (!text) return null

  // Caso pago: forma de pago sin exclusiones
  if (PAYMENT_SHAPE_RE.test(text) && !PAYMENT_EXCLUSIONS_RE.test(text)) {
    const voucherFirme = extraction.intent === 'voucher' && extraction.confianza === 'alta'
    if (!voucherFirme) {
      const nombre = extraction.proveedor || text.split(/\s+/)[0]
      return {
        kind: 'pago',
        question:
          `No me quedó claro: ¿${nombre} te pagó a vos o pagaste vos? ` +
          `Tocá una opción o respondé A/B.`,
        options: [
          { id: 'clarify_cobro', title: 'Me pagó (cobro)', intent: 'voucher' },
          { id: 'clarify_gasto', title: 'Pagué yo (gasto)', intent: 'gasto' },
        ],
      }
    }
    return null
  }

  // Caso genérico: confianza baja/dudoso PERO con hipótesis concretas
  if (extraction.confianza === 'baja' || extraction.dudoso) {
    const options: ClarifyOption[] = []
    if (extraction.monto != null || extraction.proveedor || extraction.categoria) {
      options.push({ id: 'clarify_gasto', title: 'Es un gasto', intent: 'gasto' })
    }
    if (extraction.empleado || extraction.hora || extraction.estado) {
      const isSalida = /se fue|sal[ií][oó]|me voy|me fui|chau/i.test(text)
      options.push({
        id: 'clarify_asistencia',
        title: 'Es asistencia',
        intent: isSalida ? 'asistencia_salida' : 'asistencia_llegada',
      })
    }
    if (/bastidor|acr[ií]lico|circular|tela|lienzo|marco|moldura|presupuesto|precio/i.test(text)) {
      options.push({ id: 'clarify_pedido', title: 'Es un pedido', intent: 'pedido' })
    }
    if (/deuda|saldo|debe|factura/i.test(text)) {
      options.push({ id: 'clarify_factura', title: 'Consulta de deuda', intent: 'factura' })
    }
    if (/pag[oó]|paga|abon[oó]|transfer|efectivo|comprobante/i.test(text)) {
      options.push({ id: 'clarify_cobro', title: 'Es un pago recibido', intent: 'voucher' })
    }
    // Solo preguntar con 2+ hipótesis; con 1 sola va directo a ese intent.
    if (options.length >= 2) {
      return {
        kind: 'baja_confianza',
        question:
          `No entendí bien qué quisiste registrar. Tocá una opción o respondé con la letra (A, B, C...).`,
        options: options.slice(0, 3),
      }
    }
  }

  return null
}

/**
 * ¿El texto responde a una aclaración pendiente? Acepta id de botón,
 * letra (A/B/C), número 1-based o título normalizado.
 */
export function matchClarifyOption(
  text: string,
  buttonId: string | null,
  options: ClarifyOption[],
): ClarifyOption | null {
  if (buttonId) {
    const byId = options.find((o) => o.id === buttonId)
    if (byId) return byId
  }
  const cleaned = norm(text).replace(/^(la|el|opcion)\s+/, '').replace(/[()."']+$/g, '').trim()
  if (!cleaned) return null
  if (/^[a-z]$/.test(cleaned)) {
    const idx = cleaned.charCodeAt(0) - 97
    if (idx >= 0 && idx < options.length) return options[idx]
  }
  if (/^\d{1,2}$/.test(cleaned)) {
    const idx = parseInt(cleaned, 10) - 1
    if (idx >= 0 && idx < options.length) return options[idx]
  }
  const byTitle = options.find((o) => {
    const t = norm(o.title)
    return t.includes(cleaned) || cleaned.includes(t)
  })
  return byTitle ?? null
}
