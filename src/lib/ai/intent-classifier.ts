import { callOpenRouter } from './openrouter'
import type { IntentClassification, Confidence } from '@/lib/voice-orders/types'

export type IntentTipo = 'pedido' | 'gasto' | 'voucher' | 'asistencia' | 'factura' | 'otro'

const CLASSIFIER_PROMPT = `Sos un clasificador de intenciones para un sistema de WhatsApp.
Tu trabajo: analizar el mensaje del cliente y clasificar su intención REAL.

Devolvé SOLO UN JSON con esta estructura:
{
  "tipo": "pedido" | "gasto" | "voucher" | "asistencia" | "factura" | "otro",
  "confianza": "alta" | "baja"
}

=== TIPOS DE INTENCIÓN ===

- "pedido": El cliente quiere comprar productos, pedir presupuesto, preguntar precios de productos del catálogo (bastidores, acrílicos, circulares, telas, etc.), confirmar un pedido, agregar/quitar productos del carrito, o cualquier consulta sobre productos del taller. INCLUYE: consultas de precio ("cuanto sale un bastidor 60x40"), pedidos ("quiero 3 bastidores"), confirmaciones ("dale mandalo"), respuestas sobre variantes ("sin tela", "lienzo profesional"). INCLUYE frases como "compré X" o "pagué el pedido" cuando se refieren a productos del taller.
- "gasto": El cliente registra un gasto del negocio: pago de servicios, compras para el taller, sueldos, proveedores. Palabras clave contextuales: "pagué la luz", "compré insumos", "gaste en", "transferí a proveedor". NO confundir con pedidos de clientes.
- "voucher": El cliente envía un comprobante de pago o menciona una transferencia/depósito para pagar una factura. Ej: "ahí va el comprobante", "transferí para la factura 001", "puse plata en la cuenta".
- "asistencia": El cliente marca entrada/salida del trabajo. Ej: "llegué", "buenos días", "me voy", "salida", "entrada".
- "factura": El cliente consulta por facturas pendientes, deudas, saldos. Ej: "cuánto debo?", "cómo voy con las facturas?", "qué saldo tengo?".
- "otro": Saludos genéricos ("hola", "gracias", "buen día"), conversación casual, mensajes irrelevantes, o cualquier cosa que no encaje en los tipos anteriores.

=== REGLAS IMPORTANTES (LEER CON ATENCIÓN) ===

- "compré N [producto]" (ej: "compré 3 bastidores 60x40") → pedido, NO gasto. El cliente está pidiendo productos, no registrando un gasto.
- "compré [insumo/servicio]" (ej: "compré insumos para el taller", "compré pintura") → gasto. Si menciona cantidades y medidas de productos del catálogo, es pedido.
- "pagué el pedido" → pedido (es confirmación de pedido), NO gasto.
- "pagué [servicio]" (ej: "pagué la luz", "pagué el alquiler") → gasto.
- Si menciona medidas (ej: "60x40", "100x120"), dimensiones, o productos del catálogo (bastidor, acrílico, circular, tela) → es pedido.
- Si menciona "factura", "deuda", "saldo", "debo", "pendiente" → es factura.
- Si menciona "comprobante", "transferencia", "depósito" para pagar → es voucher.
- Si es un saludo simple ("hola", "buen día", "gracias") → es otro con confianza baja.
- Ante la duda, usá confianza "baja".

=== EJEMPLOS ===

Mensaje: "Quiero 3 bastidores 60x40 sin tela"
{"tipo":"pedido","confianza":"alta"}

Mensaje: "Compré 3 bastidores 60x40"
{"tipo":"pedido","confianza":"alta"}

Mensaje: "Cuanto sale un acrilico 50x70?"
{"tipo":"pedido","confianza":"alta"}

Mensaje: "Pagué 18 mil de luz"
{"tipo":"gasto","confianza":"alta"}

Mensaje: "Gaste 4500 en insumos"
{"tipo":"gasto","confianza":"alta"}

Mensaje: "Ahí va el comprobante de la transferencia"
{"tipo":"voucher","confianza":"alta"}

Mensaje: "Transferí para la factura 001"
{"tipo":"voucher","confianza":"alta"}

Mensaje: "Buenos días jefe"
{"tipo":"asistencia","confianza":"baja"}

Mensaje: "Llegué"
{"tipo":"asistencia","confianza":"alta"}

Mensaje: "Cuánto debo?"
{"tipo":"factura","confianza":"alta"}

Mensaje: "Cómo voy con las facturas?"
{"tipo":"factura","confianza":"alta"}

Mensaje: "Pagué el pedido, mandame el comprobante"
{"tipo":"pedido","confianza":"alta"}

Mensaje: "Dale confirmo"
{"tipo":"pedido","confianza":"baja"}

Mensaje: "Hola"
{"tipo":"otro","confianza":"baja"}

Mensaje: "Gracias"
{"tipo":"otro","confianza":"baja"}

DEVOLVÉ SOLO EL JSON, NADA MÁS.`

function guessTipo(raw: string): IntentTipo {
  const valid = ['pedido', 'gasto', 'voucher', 'asistencia', 'factura', 'otro']
  const t = String(raw || '').toLowerCase()
  return valid.includes(t) ? t as IntentTipo : 'otro'
}

function guessConfianza(raw: unknown): Confidence {
  return String(raw || '') === 'baja' ? 'baja' : 'alta'
}

function extractJson(raw: string): string | null {
  const match = raw.match(/\{[\s\S]*\}/)
  return match ? match[0] : null
}

export async function classifyIntent(
  text: string,
  contextText?: string,
): Promise<IntentClassification> {
  const defaultResult: IntentClassification = { tipo: 'otro', confianza: 'baja' }

  const userMessage = contextText
    ? `CONTEXTO:\n${contextText}\n\nMENSAJE: ${text}`
    : text

  let rawText: string
  try {
    const result = await callOpenRouter({
      systemPrompt: CLASSIFIER_PROMPT,
      userMessage,
      jsonMode: true,
      temperature: 0.1,
      maxTokens: 150,
    })
    rawText = result.text
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[classifyIntent] LLM call failed:', msg)
    return defaultResult
  }

  const jsonStr = extractJson(rawText)
  if (!jsonStr) {
    console.error('[classifyIntent] No JSON in response:', rawText.slice(0, 200))
    return defaultResult
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    console.error('[classifyIntent] Invalid JSON:', jsonStr.slice(0, 200))
    return defaultResult
  }

  return {
    tipo: guessTipo(parsed.tipo as string),
    confianza: guessConfianza(parsed.confianza),
  }
}
