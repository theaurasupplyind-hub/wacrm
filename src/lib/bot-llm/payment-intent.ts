/**
 * Clasificador determinístico de pagos (cobro vs pago vs ambiguo).
 *
 * ── HECHOS DEL DOMINIO (mismos que el prompt de `extract-bot-message.ts`) ──
 * Esta capa NO "entiende": aplica estos hechos de forma barata y determinística.
 * Nunca debe contradecir al prompt.
 *
 *  1. Quien escribe es SIEMPRE el taller → 1ª persona = movió plata = gasto;
 *     3ª persona = reporta un pago de un tercero = cobro.
 *  2. "factura" SIEMPRE es la factura de VENTA → factura nombrada + verbo de pago
 *     = cobro, AUNQUE esté en 1ª persona. Hay PRECEDENCIA sobre el hecho 1: por eso
 *     el chequeo de `FACTURA_NOMBRADA_RE` va ANTES que `PAGO_RE`.
 *  3. El comprobante manda y el caption es preferencia → lo resuelve el pipeline
 *     de voucher (acá no aplica: esta capa es sólo texto).
 *  4. Forma pelada con nombre ("Jo pagó 2000") → `ambiguous`: la resuelve
 *     `detectAmbiguity`/`effect-gate` con una aclaración. Nunca auto-decidir.
 *
 * La distinción voucher (un tercero nos paga) vs gasto (nosotros pagamos) es
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

/**
 * Factura NOMBRADA: "factura de Julio", "factura F-10960", "factura 001" o un
 * id de factura suelto ("F-10960"). En este sistema "factura" siempre es la
 * factura de VENTA (saldo por cobrar), así que pagar "para la factura de X" es
 * un cobro.
 */
const FACTURA_NOMBRADA_RE = /\bfactura\s+(?:de\s+[a-z]|f-?\d{3,}|\d{3,})|\bf-?\d{4,}\b/

/**
 * Verbo de pago en PASADO ("transferí", "pagué"). Excluye el presente
 * ("pago"/"paga") a propósito: "también pago la otra factura" es un comentario,
 * no un reporte de pago (falso positivo documentado).
 */
const PAGO_PASADO_RE = /\b(transferi|transfirio|transfirieron|pague|pagaron|abone|abonaron|deposite|depositaron)\b/

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
  // "transferí/pagué para la factura de X" = cobro: la factura es NOMBRADA y el
  // verbo está en pasado. Va antes de PAGO_RE, que con su catch-all ("transferi")
  // lo tomaría como gasto.
  if (FACTURA_NOMBRADA_RE.test(n) && PAGO_PASADO_RE.test(n)) return 'voucher'
  if (PAGO_RE.test(n)) return 'expense'

  const bare = text.match(BARE_SHAPE_RE)
  if (bare && isCapitalized(bare[1])) return 'ambiguous'

  return null
}
