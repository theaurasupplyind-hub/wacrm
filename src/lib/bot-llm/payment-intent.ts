/**
 * Clasificador determinístico de pagos (cobro vs pago vs ambiguo).
 *
 * La distinción voucher (un cliente nos paga) vs gasto (nosotros pagamos) es
 * semántica: "Mati pagó" puede significar "Mati nos pagó" o el "le pagué a
 * Mati" elidido. Por eso:
 *
 *   - Marcadores EXPLÍCITOS resuelven sin preguntar.
 *   - La forma PELADA ("Nombre + pagó/paga/abonó") es AMBIGUA por diseño y
 *     SIEMPRE debe disparar la aclaración (botones), nunca auto-decidir.
 *
 * Todos los marcadores se evalúan sobre texto normalizado (sin tildes, sin
 * mayúsculas, espacios colapsados), así "pagué"/"pague"/"PAGUE" son iguales.
 * La forma pelada sí mira la capitalización del nombre en el texto original
 * (evita falsos positivos tipo "tambien pago la factura").
 */

export type PaymentIntent = 'voucher' | 'expense' | 'ambiguous' | null

/** Normaliza para matchear: minúsculas, sin diacríticos, espacios simples. */
export function normalizeForMatch(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Un cliente NOS paga (cobro). */
const COBRO_RE =
  /\b(me|nos)\s+(pago|pagan|pagaron|transfirio|transfirieron|deposito|depositaron|abono|abonaron)\b|\bpago recibido\b|\brecibi (el |un )?pago\b|\bcobro recibido\b/

/** Nosotros pagamos a alguien (gasto), o es sueldo/adelanto. */
const PAGO_RE =
  /\b(le|les)\s+(pague|pagamos|pago|pagan|pagaron|transfiri|transfirio|transfirieron|abone|abono|abonaron|deposite|deposito)\b|\bpague\s+(a|al|a la|a los|el|la)\b|\btransfiri\s+(a|al)\b|\babone\s+(a|al)\b|\b(sueldo|sueldos|adelanto|a cuenta)\b|\b(pague|compre|abone|deposite|transferi)\b/

/** Forma pelada: "Nombre + pagó/paga/abonó ..." (sobre el texto ORIGINAL). */
const BARE_SHAPE_RE =
  /^\s*([A-Za-zÁÉÍÓÚÑáéíóúñ]+(?:\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]+){0,2})\s+(pag[oó]|paga|pagan|pagaron|abon[oó]|abona|abonan|abonaron|transfiri[oó]|transfirieron)\b/i

function isCapitalized(name: string): boolean {
  const c = name.trim()[0]
  return !!c && c === c.toUpperCase() && c !== c.toLowerCase()
}

/**
 * Clasifica la intención de pago del texto.
 * - 'voucher': marcador explícito de cobro.
 * - 'expense': marcador explícito de pago propio / sueldo.
 * - 'ambiguous': forma pelada → debe aclararse con el usuario.
 * - null: sin señal de pago.
 */
export function classifyPaymentIntent(raw: string): PaymentIntent {
  const text = (raw || '').trim()
  if (!text) return null
  const n = normalizeForMatch(text)

  if (COBRO_RE.test(n)) return 'voucher'
  if (PAGO_RE.test(n)) return 'expense'

  const bare = text.match(BARE_SHAPE_RE)
  if (bare && isCapitalized(bare[1])) return 'ambiguous'

  return null
}
