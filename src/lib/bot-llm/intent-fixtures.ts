import type { IntentCase } from './eval'

/**
 * Golden set curado de intents (semilla). Ampliar con datos reales exportados
 * de `router_logs` (campo `debug_info.extraction.raw` + `intent` corregido a
 * mano). Sirve para `intent-eval.live.test.ts`.
 */
export const INTENT_FIXTURES: IntentCase[] = [
  // ── gasto ──
  { text: 'pagué 18 mil de luz', expected: 'gasto' },
  { text: 'gasté 5000 en insumos', expected: 'gasto' },
  { text: 'pagué el alquiler 250000', expected: 'gasto' },
  { text: 'compré pintura a Ferretería López por 8000', expected: 'gasto' },
  { text: 'Le pagué a Marlon 2000000 por sueldo', expected: 'gasto' },
  { text: 'transferí a Jorge 15000', expected: 'gasto' },

  // ── multi_expense ──
  { text: 'gasté 5000 en luz y 2000 en gas', expected: 'multi_expense' },
  { text: '$40 mil nafta, $34.500 bulonera, 38.000 empanadas', expected: 'multi_expense' },

  // ── voucher (cobro de cliente) ──
  { text: 'Jo pago en efectivo', expected: 'voucher' },
  { text: 'Marlon Pago 2000000', expected: 'voucher' },
  { text: 'Jo pago en transferencia a Jorge', expected: 'voucher' },
  { text: 'Mathias pago en efectivo todo', expected: 'voucher' },
  { text: 'transferí para la factura 001', expected: 'voucher' },

  // ── asistencia ──
  { text: 'llegó juan a las 8:30', expected: 'asistencia_llegada' },
  { text: 'llegó juan', expected: 'asistencia_llegada' },
  { text: 'juan se fue a las 17:00', expected: 'asistencia_salida' },
  { text: 'me voy a las 18', expected: 'asistencia_salida' },
  { text: 'juan está de vacaciones', expected: 'asistencia_estado' },

  // ── factura / deuda ──
  { text: 'cuánto debe Aldo?', expected: 'factura' },
  { text: 'Necesito saber cuanto debe un cliente', expected: 'factura' },
  { text: '¿Jimena tiene alguna factura?', expected: 'factura' },
  { text: '¿pagó Carlitos?', expected: 'factura' },

  // ── otro ──
  { text: 'hola', expected: 'otro' },
  { text: 'qué podés hacer?', expected: 'otro' },
  { text: 'quién sos?', expected: 'otro' },
  { text: 'gracias!', expected: 'otro' },
  { text: 'se fue la luz', expected: 'otro' },

  // ── casos reales de router_logs ──
  { text: 'quiero ver las boxy fit lisas', expected: 'otro' },
  { text: 'te pido catalogo', expected: 'otro' },
  { text: 'cuánto debe ursula?', expected: 'factura' },

  // ── deuda con proveedor (deber 3ª persona → factura, NUNCA gasto) ──
  { text: '2.963.912 es lo que se debe de madera transferencia', expected: 'factura' },
  { text: 'le debemos 3 millones a Puerto Maderas', expected: 'factura' },
  { text: 'debemos 50000 a la bulonera', expected: 'factura' },
  { text: 'debo 98mil al proveedor de maderas', expected: 'factura' },
]
