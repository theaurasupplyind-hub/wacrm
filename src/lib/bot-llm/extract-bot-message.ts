import { callOpenRouter } from '@/lib/ai/openrouter'
import { fallbackExtract } from './fallback'
import { extractJson, normalizeDate, normalizeTime, parseMontoSafe } from './sanitize'
import type { BotIntent, Confidence, MissingField, MultiExpenseItem, UnifiedExtraction } from './types'

const EXTRACT_PROMPT = `Sos un extractor de intenciones y datos para un sistema de WhatsApp (taller de bastidores GAL + gestión de gastos, asistencia y vouchers).

Analizá el mensaje del usuario y devolvé SOLO UN JSON con esta estructura exacta:
{
  "intent": "asistencia_llegada" | "asistencia_salida" | "asistencia_estado" | "gasto" | "multi_expense" | "voucher" | "pedido" | "factura" | "otro",
  "confianza": "alta" | "media" | "baja",
  "empleado": "nombre del empleado o null",
  "hora": "HH:MM o null",
  "estado": "vacaciones" | "licencia" | "ausente" | null,
  "monto": número o null,
  "categoria": "categoría del gasto o null",
  "proveedor": "nombre del proveedor o null",
  "empleado_gasto": "nombre del empleado si es pago de sueldo, o null",
  "metodo_pago": "efectivo" | "transferencia" | "debito" | "credito" | "mercado pago" | "qr" | null,
  "fecha": "YYYY-MM-DD o null",
  "multipleExpenses": [
    {
      "monto": número o null,
      "categoria": "categoría o null",
      "proveedor": "proveedor o null",
      "empleado": "empleado o null",
      "metodo_pago": "método o null",
      "descripcion": "texto del gasto o null"
    }
  ],
  "faltan_campos": ["empleado" | "hora" | "estado" | "monto" | "categoria" | "proveedor"],
  "dudoso": true | false,
  "razon_duda": "texto breve explicando la duda o null"
}

=== INTENTS ===

- "asistencia_llegada": llegada al trabajo ("llegó", "llegue", "llegada", "buenos días"). Necesita empleado + hora.
- "asistencia_salida": salida del trabajo ("salgo", "salí", "me voy", "me fui", "se fue", "terminé", "chau"). Necesita empleado + hora.
- "asistencia_estado": vacaciones, licencia o ausente. Necesita empleado.
- "gasto": registro de UN gasto del negocio (servicios, insumos, sueldos, proveedores). Necesita monto.
- "multi_expense": un mismo mensaje contiene DOS O MÁS gastos separados e independientes del negocio. Devolvé la lista en "multipleExpenses". Cada gasto debe tener su propio monto.
- "voucher": comprobante de pago o transferencia/depósito para pagar una factura.
- "pedido": el cliente quiere comprar productos del catálogo (bastidores, acrílicos, circulares, telas), pedir presupuesto, precios, o confirmar un pedido.
- "factura": consulta de facturas pendientes, deudas, saldos.
- "otro": saludos genéricos ("hola", "gracias"), charla casual, mensajes irrelevantes, o respuestas que no completan ninguna intención pendiente.

=== REGLAS (MUY IMPORTANTES) ===

- "compré N [producto]" (ej: "compré 3 bastidores 60x40") → pedido, NUNCA gasto. Si menciona cantidades, medidas o productos del catálogo (bastidor, acrílico, circular, tela, lienzo, marco, moldura) → pedido.
- "compré [insumo/servicio]" (ej: "compré insumos para el taller", "compré pintura") → gasto.
- "pagué el pedido" → pedido (confirmación de pedido), NO gasto.
- "pagué [servicio]" (ej: "pagué la luz", "pagué el alquiler") → gasto.
- "transferí/deposité/puse plata para factura/comprobante" → voucher, NUNCA gasto.
- "se fue la luz", "se cortó la luz" → NO es asistencia. Solo "se fue [persona]" con nombre es salida.
- Si consulta "factura", "deuda", "saldo", "debo", "pendiente" → factura.
- Ante la duda, usá confianza "baja" o "media".

=== MULTI-EXPENSE ===

Usá "multi_expense" SOLO si el mensaje lista DOS O MÁS gastos distintos con sus propios montos. Cada gasto va como un objeto en "multipleExpenses" con su monto y categoría.
- "gaste 5000 en luz y 2000 en gas" → multi_expense: [{monto:5000,categoria:"luz"},{monto:2000,categoria:"gas"}].
- "$40 mil nafta, $34.500 bulonera, 38.000 empanadas" → multi_expense con 3 gastos.
- "pagué 18 mil de luz" → gasto simple (UN monto), NO multi_expense.
- "pagué 5.000 por transferencia y 2.000 en efectivo" → gasto simple con split de pago (mismo gasto, dos métodos), NO multi_expense. Devolvé "monto": 7000.
- "saldo en transferencia es X y saldo en efectivo es Y" → gasto simple con saldo, NO multi_expense.
- Un solo monto → gasto simple, NUNCA multi_expense.
- Una descripción con varios conceptos pero UN monto ("pago de luz y gas") → gasto simple.
- Si un gasto de la lista no tiene categoría clara, poné "categoria": null (el bot preguntará).

=== CAMPOS ===

- "empleado": nombre de la persona para asistencia.
- "hora": normalizá a HH:MM ("8:30"→"08:30", "830"→"08:30", "a las 17"→"17:00").
- "estado": solo si el mensaje indica vacaciones, licencia o ausente.
- "monto": número sin símbolos ni texto ("18 mil"→18000, "18k"→18000, "$18.000,00"→18000, "18,000.00"→18000).
- "categoria": tipo de gasto (luz, alquiler, insumos, sueldo, etc.).
- "proveedor": destinatario del pago si se menciona.
- "empleado_gasto": solo si es pago de sueldo a un empleado.
- "metodo_pago": efectivo, transferencia, débito, crédito, mercado pago, qr, o null.
- "fecha": YYYY-MM-DD si se menciona ("15/7/26"→"2026-07-15", "ayer", "hoy"); si no, null.

=== faltan_campos ===

Campos que el mensaje NO aporta y que el intent necesita:
- llegada/salida: "empleado" y "hora" si faltan.
- estado: "empleado" si falta.
- gasto: "monto" si falta. "categoria" y "proveedor" si faltan (opcionales).
No incluyas campos que el contexto pendiente ya aporta.

=== dudoso ===

true si: el monto es ambiguo, hay dos montos candidatos, la categoría es nueva/inferida, el proveedor/empleado no es seguro, o el mensaje es corto/genérico sin datos claros. "razon_duda" es un texto breve explicando la duda (o null).

=== CONTEXTO ===

El mensaje puede ser la respuesta a una pregunta pendiente del bot (multi-turn). En ese caso devolvé el intent pendiente con los campos que el mensaje completa:
- Si el contexto dice que se espera la hora de llegada de juan y el mensaje es "9:30" → intent "asistencia_llegada", empleado "juan", hora "09:30".
- Si el contexto dice "¿De quién es?" y el mensaje es "juan" → intent "asistencia_llegada", empleado "juan".
- Si el contexto dice que se espera el monto del gasto y el mensaje es "5000" → intent "gasto", monto 5000.

=== EJEMPLOS ===

Mensaje: "compré 3 bastidores 60x40 sin tela"
{"intent":"pedido","confianza":"alta","empleado":null,"hora":null,"estado":null,"monto":null,"categoria":null,"proveedor":null,"empleado_gasto":null,"metodo_pago":null,"fecha":null,"faltan_campos":[],"dudoso":false,"razon_duda":null}

Mensaje: "pagué 18 mil de luz"
{"intent":"gasto","confianza":"alta","empleado":null,"hora":null,"estado":null,"monto":18000,"categoria":"luz","proveedor":null,"empleado_gasto":null,"metodo_pago":null,"fecha":null,"faltan_campos":[],"dudoso":false,"razon_duda":null}

Mensaje: "transferí para la factura 001"
{"intent":"voucher","confianza":"alta","empleado":null,"hora":null,"estado":null,"monto":null,"categoria":null,"proveedor":null,"empleado_gasto":null,"metodo_pago":"transferencia","fecha":null,"faltan_campos":[],"dudoso":false,"razon_duda":null}

Mensaje: "llegó juan a las 8:30"
{"intent":"asistencia_llegada","confianza":"alta","empleado":"juan","hora":"08:30","estado":null,"monto":null,"categoria":null,"proveedor":null,"empleado_gasto":null,"metodo_pago":null,"fecha":null,"faltan_campos":[],"dudoso":false,"razon_duda":null}

Mensaje: "juan se fue a las 17:00"
{"intent":"asistencia_salida","confianza":"alta","empleado":"juan","hora":"17:00","estado":null,"monto":null,"categoria":null,"proveedor":null,"empleado_gasto":null,"metodo_pago":null,"fecha":null,"faltan_campos":[],"dudoso":false,"razon_duda":null}

Mensaje: "juan está de vacaciones"
{"intent":"asistencia_estado","confianza":"alta","empleado":"juan","hora":null,"estado":"vacaciones","monto":null,"categoria":null,"proveedor":null,"empleado_gasto":null,"metodo_pago":null,"fecha":null,"faltan_campos":[],"dudoso":false,"razon_duda":null}

Mensaje: "llegó juan"
{"intent":"asistencia_llegada","confianza":"media","empleado":"juan","hora":null,"estado":null,"monto":null,"categoria":null,"proveedor":null,"empleado_gasto":null,"metodo_pago":null,"fecha":null,"faltan_campos":["hora"],"dudoso":true,"razon_duda":"Falta la hora de llegada"}

Mensaje: "se fue la luz"
{"intent":"otro","confianza":"alta","empleado":null,"hora":null,"estado":null,"monto":null,"categoria":null,"proveedor":null,"empleado_gasto":null,"metodo_pago":null,"fecha":null,"faltan_campos":[],"dudoso":false,"razon_duda":null}

Mensaje: "cuánto debo?"
{"intent":"factura","confianza":"alta","empleado":null,"hora":null,"estado":null,"monto":null,"categoria":null,"proveedor":null,"empleado_gasto":null,"metodo_pago":null,"fecha":null,"faltan_campos":[],"dudoso":false,"razon_duda":null}

Mensaje: "hola"
{"intent":"otro","confianza":"baja","empleado":null,"hora":null,"estado":null,"monto":null,"categoria":null,"proveedor":null,"empleado_gasto":null,"metodo_pago":null,"fecha":null,"multipleExpenses":[],"faltan_campos":[],"dudoso":false,"razon_duda":null}

Mensaje: "gaste 5000 en luz y 2000 en gas"
{"intent":"multi_expense","confianza":"alta","empleado":null,"hora":null,"estado":null,"monto":null,"categoria":null,"proveedor":null,"empleado_gasto":null,"metodo_pago":null,"fecha":null,"multipleExpenses":[{"monto":5000,"categoria":"luz","proveedor":null,"empleado":null,"metodo_pago":null,"descripcion":"luz"},{"monto":2000,"categoria":"gas","proveedor":null,"empleado":null,"metodo_pago":null,"descripcion":"gas"}],"faltan_campos":[],"dudoso":false,"razon_duda":null}

Mensaje: "Gastos varios dia lunes: $40 mil nafta, $34.500 bulonera, 38.000 empanadas"
{"intent":"multi_expense","confianza":"media","empleado":null,"hora":null,"estado":null,"monto":null,"categoria":null,"proveedor":null,"empleado_gasto":null,"metodo_pago":null,"fecha":null,"multipleExpenses":[{"monto":40000,"categoria":"nafta","proveedor":null,"empleado":null,"metodo_pago":null,"descripcion":"nafta"},{"monto":34500,"categoria":"bulonera","proveedor":null,"empleado":null,"metodo_pago":null,"descripcion":"bulonera"},{"monto":38000,"categoria":"empanadas","proveedor":null,"empleado":null,"metodo_pago":null,"descripcion":"empanadas"}],"faltan_campos":[],"dudoso":false,"razon_duda":null}

DEVOLVÉ SOLO EL JSON, NADA MÁS.`

const VALID_INTENTS: BotIntent[] = [
  'asistencia_llegada', 'asistencia_salida', 'asistencia_estado',
  'gasto', 'multi_expense', 'voucher', 'pedido', 'factura', 'otro',
]
const VALID_CONFIDENCE: Confidence[] = ['alta', 'media', 'baja']
const VALID_MISSING: MissingField[] = ['empleado', 'hora', 'estado', 'monto', 'categoria', 'proveedor']
const VALID_ESTADOS = ['vacaciones', 'licencia', 'ausente'] as const

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function guessIntent(raw: unknown): BotIntent | null {
  const v = String(raw || '')
  return VALID_INTENTS.includes(v as BotIntent) ? (v as BotIntent) : null
}

function guessConfianza(raw: unknown): Confidence | null {
  const v = String(raw || '')
  return VALID_CONFIDENCE.includes(v as Confidence) ? (v as Confidence) : null
}

function sanitizeParsed(parsed: Record<string, unknown>, raw: string): UnifiedExtraction {
  const intent = guessIntent(parsed.intent)
  const confianza = guessConfianza(parsed.confianza)
  if (!intent || !confianza) {
    throw new Error(
      `[extractBotMessage] esquema fuera de rango: intent=${String(parsed.intent)} confianza=${String(parsed.confianza)}`,
    )
  }

  const estado = VALID_ESTADOS.includes(parsed.estado as (typeof VALID_ESTADOS)[number])
    ? (parsed.estado as 'vacaciones' | 'licencia' | 'ausente')
    : null

  const multipleExpenses = Array.isArray(parsed.multipleExpenses)
    ? parsed.multipleExpenses
        .map(sanitizeMultiExpenseItem)
        .filter((i): i is MultiExpenseItem => i !== null)
    : undefined

  return {
    intent,
    confianza,
    extractor_source: 'llm',
    empleado: strOrNull(parsed.empleado),
    hora: normalizeTime(parsed.hora),
    estado,
    monto: parseMontoSafe(parsed.monto),
    categoria: strOrNull(parsed.categoria),
    proveedor: strOrNull(parsed.proveedor),
    empleado_gasto: strOrNull(parsed.empleado_gasto),
    metodo_pago: strOrNull(parsed.metodo_pago),
    multipleExpenses,
    fecha: normalizeDate(parsed.fecha),
    faltan_campos: Array.isArray(parsed.faltan_campos)
      ? parsed.faltan_campos.filter((f): f is MissingField => VALID_MISSING.includes(f as MissingField))
      : [],
    dudoso: parsed.dudoso === true,
    razon_duda: strOrNull(parsed.razon_duda),
    raw,
  }
}

/** Normaliza un item de "multipleExpenses" devuelto por el LLM. */
function sanitizeMultiExpenseItem(raw: unknown): MultiExpenseItem | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const item: MultiExpenseItem = {
    amount: parseMontoSafe(o.monto),
    category: strOrNull(o.categoria),
    provider: strOrNull(o.proveedor),
    employee: strOrNull(o.empleado),
    payment_method: strOrNull(o.metodo_pago),
    description: strOrNull(o.descripcion),
    date: normalizeDate(o.fecha),
    raw: strOrNull(o.descripcion) || '',
  }
  // Descartar items totalmente vacíos (sin monto ni categoría).
  if (item.amount === null && item.category === null) return null
  return item
}

/**
 * Extractor único por LLM: intent + campos estructurados + faltan_campos + dudoso.
 * Ante fallo/timeout/JSON inválido/schema fuera de rango cae a `fallbackExtract`
 * (regex) con confianza 'baja'.
 */
export async function extractBotMessage(
  text: string,
  contextText?: string,
): Promise<UnifiedExtraction> {
  const raw = (text || '').trim()
  if (!raw) return fallbackExtract(raw)

  const userMessage = contextText
    ? `CONTEXTO (últimos mensajes + estado pendiente del bot):\n${contextText}\n\nMENSAJE: ${raw}`
    : raw

  let rawText: string
  try {
    const result = await callOpenRouter({
      systemPrompt: EXTRACT_PROMPT,
      userMessage,
      jsonMode: true,
      temperature: 0.1,
      maxTokens: 1100,
    })
    rawText = result.text
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[extractBotMessage] LLM call failed:', msg)
    return fallbackExtract(raw)
  }

  const jsonStr = extractJson(rawText)
  if (!jsonStr) {
    console.error('[extractBotMessage] No JSON in response:', rawText.slice(0, 200))
    return fallbackExtract(raw)
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    console.error('[extractBotMessage] Invalid JSON:', jsonStr.slice(0, 200))
    return fallbackExtract(raw)
  }

  try {
    return sanitizeParsed(parsed, raw)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[extractBotMessage] Sanitization failed:', msg)
    return fallbackExtract(raw)
  }
}
