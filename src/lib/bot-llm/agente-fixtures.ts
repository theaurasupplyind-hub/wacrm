import type { BotIntent } from './types'

/**
 * Dataset de eval del plan agente-conversacional (Fase 0 → Fase 5).
 *
 * Casos sintéticos (sin PII, commiteables) que cubren los usos reales del
 * operador: gastos, asistencia, vouchers, facturas, pedidos, correcciones,
 * multi-turno y multi-intent. Cada caso etiqueta:
 * - `expected`: intent esperado del extractor actual.
 * - `behavior`: lo que la DEFINICIÓN de ambigüedad
 *   (`docs/bots/definicion-ambiguedad.md`) prescribe: auto-save o confirmación.
 *   Hoy es informativo (el gate se implementa en Fase 2); en Fase 2+ se vuelve
 *   afirmable.
 *
 * Supuesto: entidades mencionadas existen salvo que el texto sugiera novedad.
 * S3/S4 (match débil/entidad nueva) dependen de la DB real y no se etiquetan
 * acá: `behavior` refleja señales de texto (S1/S2/S5/S6).
 *
 * El mismo dataset se reusa en Fase 5 para comparar modelos (Gemini vs
 * DeepSeek): no cambiar textos sin versionar el baseline.
 */
export interface AgenteCase {
  text: string
  expected: BotIntent
  contextText?: string
  behavior: 'auto' | 'confirma'
  note?: string
}

export const AGENTE_FIXTURES: AgenteCase[] = [
  // ── gasto claro → auto ──
  { text: 'pagué 18 mil de luz', expected: 'gasto', behavior: 'auto' },
  { text: 'gasté 5000 en insumos', expected: 'gasto', behavior: 'auto' },
  { text: 'pagué el alquiler 250000', expected: 'gasto', behavior: 'auto' },
  { text: 'transferí 15000 a Jorge por flete', expected: 'gasto', behavior: 'auto' },
  { text: 'compré pintura por 8000', expected: 'gasto', behavior: 'auto' },
  { text: 'pagué 350.75 en fletes', expected: 'gasto', behavior: 'auto' },
  { text: 'gasté $18.000,50 en nafta', expected: 'gasto', behavior: 'auto' },
  { text: 'le pagué a Marlon 2000000 por sueldo', expected: 'gasto', behavior: 'auto' },

  // ── gasto con dato faltante/dudoso → confirma (S5) ──
  { text: 'anotá un gasto de luz', expected: 'gasto', behavior: 'confirma', note: 'S5: falta monto' },
  { text: 'gasté en algo de la ferretería', expected: 'gasto', behavior: 'confirma', note: 'S5: falta monto' },
  { text: 'pagué 5000', expected: 'gasto', behavior: 'confirma', note: 'S5: sin destino ni categoría' },
  { text: 'creo que pagué algo de luz, no me acuerdo cuánto', expected: 'gasto', behavior: 'confirma', note: 'S1+S5' },

  // ── multi_expense → auto ──
  { text: 'gasté 5000 en luz y 2000 en gas', expected: 'multi_expense', behavior: 'auto' },
  { text: '$40 mil nafta, $34.500 bulonera', expected: 'multi_expense', behavior: 'auto' },

  // ── voucher → auto, salvo banda pelada (S2) ──
  { text: 'Jo pago en efectivo', expected: 'voucher', behavior: 'auto' },
  { text: 'Marlon Pago 2000000', expected: 'voucher', behavior: 'auto' },
  { text: 'Jo pago', expected: 'voucher', behavior: 'confirma', note: 'S2: banda de pago pelada' },

  // ── asistencia ──
  { text: 'llegó juan a las 8:30', expected: 'asistencia_llegada', behavior: 'auto' },
  { text: 'juan se fue a las 17:00', expected: 'asistencia_salida', behavior: 'auto' },
  { text: 'me voy', expected: 'asistencia_salida', behavior: 'confirma', note: 'S5: falta hora' },
  { text: 'juan está de vacaciones', expected: 'asistencia_estado', behavior: 'auto' },
  { text: 'llegó a las 9', expected: 'asistencia_llegada', behavior: 'confirma', note: 'S5: falta empleado' },

  // ── factura / deuda (lectura) → auto ──
  { text: 'cuánto debe Aldo?', expected: 'factura', behavior: 'auto' },
  { text: '¿pagó Carlitos?', expected: 'factura', behavior: 'auto' },
  { text: 'pasame el saldo de Jorge', expected: 'factura', behavior: 'auto' },

  // ── pedido ──
  { text: 'cuánto sale un bastidor de 100x120', expected: 'pedido', behavior: 'auto', note: 'solo lectura (precio), no escribe' },
  { text: 'necesito 2 bastidores de 60x40', expected: 'pedido', behavior: 'confirma', note: 'S6: cotizar vs crear' },
  { text: '1 rollo de tela 2x5', expected: 'pedido', behavior: 'confirma', note: 'S6: posible creación' },
  { text: 'haceme la factura para Jo por el bastidor 60x40', expected: 'pedido', behavior: 'confirma', note: 'S6: creación explícita' },
  {
    text: 'dale, hacelo',
    expected: 'pedido',
    behavior: 'auto',
    contextText: 'Pedido pendiente: presupuesto 2x bastidor 60x40 para Jo, total $50000. Esperando confirmación.',
    note: 'multi-turno: confirma pendiente',
  },

  // ── correcciones (Fase 2+: flusso corrección; hoy van a otro/asistente) ──
  {
    text: 'te equivocaste, eran 3 no 2',
    expected: 'otro',
    behavior: 'confirma',
    contextText: 'Gasto pendiente: 2x insumos $5000. Esperando confirmación.',
    note: 'corrección sobre pendiente; Fase 2 lo rutea a fix, hoy informativo',
  },
  {
    text: 'no, el proveedor era Edesur',
    expected: 'otro',
    behavior: 'confirma',
    contextText: 'Gasto pendiente: $18000 categoría Luz, proveedor sin resolver. Esperando dato.',
    note: 'corrección de entidad; Fase 2 lo rutea a fix, hoy informativo',
  },
  { text: 'cancelá eso', expected: 'otro', behavior: 'auto', note: 'comando cancelar → limpia pendientes' },

  // ── multi-intent (Fase 4: el agente lo resuelve; hoy un solo intent) ──
  { text: 'pagué la luz y llegó Juan a las 8:30', expected: 'gasto', behavior: 'auto', note: 'multi-intent: hoy un intent; Fase 4 ejecuta ambos' },
  { text: 'cuánto debe Jo? y pasame un presupuesto de 2 bastidores 60x40', expected: 'factura', behavior: 'auto', note: 'multi-intent: hoy un intent; Fase 4 ejecuta ambos' },

  // ── otro → auto ──
  { text: 'hola', expected: 'otro', behavior: 'auto' },
  { text: 'qué podés hacer?', expected: 'otro', behavior: 'auto' },
  { text: 'gracias!', expected: 'otro', behavior: 'auto' },
]
