import { engineSendText } from '@/lib/flows/meta-send'
import {
  getFacturasPendientes,
  buscarProductos,
  type Producto,
} from '../facbal/client'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const TIMEOUT_MS = 20_000
const DEFAULT_MODEL = 'google/gemini-2.5-flash'

interface ChatArgs {
  text: string
  phone: string
  accountId: string
  userId: string
  contactId: string
  conversationId: string
}

type IntentType = 'pending_invoices' | 'product_search' | 'general' | 'ignore'

/**
 * Send a WhatsApp reply that persists in the CRM inbox.
 */
async function reply(
  ctx: { accountId: string; userId: string; contactId: string; conversationId: string },
  text: string,
): Promise<void> {
  try {
    await engineSendText({
      accountId: ctx.accountId,
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      contactId: ctx.contactId,
      text,
    })
    console.log('[chatbot] Reply sent OK')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[chatbot] Reply failed:', msg)
  }
}

/**
 * Call OpenRouter with a simple text prompt.
 */
async function callOpenRouter(args: {
  systemPrompt: string
  userMessage: string
}): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set')

  const model = process.env.VOUCHER_AI_MODEL || DEFAULT_MODEL

  let res: Response
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: args.systemPrompt },
          { role: 'user', content: args.userMessage },
        ],
        max_tokens: 512,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error('OpenRouter tardó demasiado en responder.')
    }
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Error al contactar OpenRouter: ${msg}`)
  }

  if (!res.ok) {
    let detail = ''
    try {
      const body = (await res.json()) as { error?: { message?: string } }
      detail = body?.error?.message || ''
    } catch { /* ignore */ }
    throw new Error(`OpenRouter error ${res.status}${detail ? `: ${detail}` : ''}`)
  }

  const data = await res.json() as { choices?: { message?: { content?: string } }[] }
  const text = data?.choices?.[0]?.message?.content
  if (!text || !text.trim()) throw new Error('OpenRouter devolvió respuesta vacía.')
  return text.trim()
}

const INTENT_SYSTEM_PROMPT = `Sos un clasificador de intenciones para un negocio de marcos y molduras (Bastidores GAL).

Analizá el mensaje del cliente y respondé EXCLUSIVAMENTE con una sola palabra:

- "pending_invoices" si pregunta por facturas pendientes, deuda, saldo, cuánto debe, pagos
- "product_search" si pregunta por productos, precios, medidas, stock, varillas, telas, molduras, rollos
- "ignore" si es un saludo simple ("hola", "gracias"), una respuesta corta, o algo que no requiere consulta a la base de datos

Solo respondé con la palabra, sin comillas ni texto adicional.`

/**
 * Detect intent from a customer text message using OpenRouter.
 */
async function detectIntent(text: string): Promise<IntentType> {
  try {
    const result = await callOpenRouter({
      systemPrompt: INTENT_SYSTEM_PROMPT,
      userMessage: text,
    })
    const cleaned = result.trim().toLowerCase()
    if (cleaned.includes('pending_invoices')) return 'pending_invoices'
    if (cleaned.includes('product_search')) return 'product_search'
    if (cleaned.includes('ignore')) return 'ignore'
    if (cleaned.includes('general')) return 'general'
    if (text.length > 30) return 'general' // longer messages are questions
    return 'ignore'
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[chatbot] Intent detection failed:', msg)
    // Fallback: short messages = ignore, longer = try to answer
    return text.length > 25 ? 'general' : 'ignore'
  }
}

const CHAT_SYSTEM_PROMPT = `Sos un asistente virtual de Bastidores GAL, un taller de marcos y molduras.

Reglas:
- Respondé en español argentino, con tono cordial y profesional.
- Usá SOLO los datos que te paso abajo. No inventes precios, productos ni información.
- Si la información que te doy no alcanza para responder, decilo honestamente: "No tengo ese dato, un agente te lo confirma."
- Sé breve, estás en WhatsApp. Máximo 3-4 oraciones.
- Si el cliente pregunta algo que no está en los datos, ofrecé derivarlo a un agente humano.

DATOS DEL SISTEMA:`

function formatProductos(products: Producto[]): string {
  if (products.length === 0) return 'No se encontraron productos.'
  return products
    .map(
      (p) =>
        `- ${p.descripcion}${p.medida ? ` (${p.medida})` : ''}${p.variante ? ` ${p.variante}` : ''}: $${p.precio_unitario.toFixed(2)}${p.stock != null ? ` [stock: ${p.stock}]` : ''}`,
    )
    .join('\n')
}

function formatInvoices(facturas: { numero_factura: string; saldo_pendiente: number; total: number; fecha: string }[]): string {
  if (facturas.length === 0) return 'No hay facturas pendientes.'
  return facturas
    .map(
      (f) =>
        `- ${f.numero_factura} (${f.fecha}): total $${f.total.toFixed(2)}, pendiente $${f.saldo_pendiente.toFixed(2)}`,
    )
    .join('\n')
}

export async function processChatMessage(args: ChatArgs): Promise<void> {
  const { text, phone, accountId, userId, contactId, conversationId } = args
  const sendCtx = { accountId, userId, contactId, conversationId }

  console.log('[chatbot] Processing: "%s" from phone=%s', text.slice(0, 60), phone.slice(-6))

  // Step 1 — Detect intent
  let intent: IntentType
  try {
    intent = await detectIntent(text)
  } catch (err) {
    console.error('[chatbot] detectIntent error:', err)
    return
  }

  if (intent === 'ignore') {
    console.log('[chatbot] Ignoring message (intent=ignore)')
    return
  }

  console.log('[chatbot] Intent detected: %s', intent)

  // Step 2 — Fetch data from FacBal
  let dataContext = ''
  try {
    if (intent === 'pending_invoices' || intent === 'general') {
      try {
        const facturas = await getFacturasPendientes(phone)
        dataContext += '\nFACTURAS PENDIENTES:\n' + formatInvoices(facturas) + '\n'
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[chatbot] FacBal invoices failed:', msg)
        dataContext += '\nFACTURAS PENDIENTES: Error al consultar\n'
      }
    }

    if (intent === 'product_search' || intent === 'general') {
      try {
        const productos = await buscarProductos(text)
        dataContext += '\nPRODUCTOS ENCONTRADOS:\n' + formatProductos(productos) + '\n'
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[chatbot] FacBal products failed:', msg)
        dataContext += '\nPRODUCTOS: Error al consultar\n'
      }
    }
  } catch (err) {
    console.error('[chatbot] data fetch error:', err)
    return
  }

  // Step 3 — Generate response
  try {
    console.log('[chatbot] Generating response with context size=%d', dataContext.length)
    const respuesta = await callOpenRouter({
      systemPrompt: CHAT_SYSTEM_PROMPT + '\n\n' + dataContext,
      userMessage: text,
    })

    await reply(sendCtx, respuesta)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[chatbot] Generate response failed:', msg)
  }

  console.log('[chatbot] END intent=%s', intent)
}
