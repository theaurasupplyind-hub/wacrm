import { engineSendText, engineSendMedia } from '@/lib/flows/meta-send'
import {
  getFacturasPendientes,
  buscarProductos,
  suggestPrice,
  getPriceListImages,
  bulkPrice,
  type SugerenciaPrecio,
  type SuggestPriceResult,
  type BulkPriceItem,
  type BulkPriceResult,
  type Producto,
} from '../facbal/client'
import { createCart, addToCart, formatCartForLLM, formatCartBudget, type CartState } from './cart-state'
import { determineFlow } from './conversation-flow'
import { shouldHardHandoff, shouldHandoff } from './handoff-rules'
import { logChatbotStep } from './chatbot-logger'
import { supabaseAdmin } from './admin-client'

export const CHATBOT_ENABLED = false

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const TIMEOUT_MS = 20_000
const DEFAULT_CHAT_MODEL = 'google/gemini-2.5-flash-lite'
const HANDOFF_SENTINEL = '[[HANDOFF]]'
export const SHOW_BUDGET_SENTINEL = '[[SHOW_BUDGET]]'

interface ChatArgs {
  text: string
  phone: string
  accountId: string
  userId: string
  contactId: string
  conversationId: string
}

type IntentType = 'pending_invoices' | 'product_search' | 'price_list' | 'order_request' | 'confirm_order' | 'view_budget' | 'cancel_order' | 'general' | 'ignore'

interface DetectedIntent {
  intent: IntentType
  priceListCategory?: string
}

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

export async function callOpenRouter(args: {
  systemPrompt: string
  userMessage: string
}): Promise<{ text: string; usage: { prompt_tokens: number; completion_tokens: number } }> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set')

  const model = process.env.CHATBOT_AI_MODEL || DEFAULT_CHAT_MODEL

  console.log(`[callOpenRouter] model=${model} promptLen=${args.systemPrompt.length}B userLen=${args.userMessage.length}B`)

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

  const data = await res.json() as {
    choices?: { message?: { content?: string } }[]
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
  }
  const text = data?.choices?.[0]?.message?.content
  if (!text || !text.trim()) throw new Error('OpenRouter devolvió respuesta vacía.')

  return {
    text: text.trim(),
    usage: {
      prompt_tokens: data.usage?.prompt_tokens ?? 0,
      completion_tokens: data.usage?.completion_tokens ?? 0,
    },
  }
}

export const CHAT_SYSTEM_PROMPT = `Sos un asistente virtual de Bastidores GAL, un taller de marcos y molduras.

REGLA #1 — PROHIBIDO ABSOLUTO: Nunca uses "Hola", "Buen día", "Buenas", "¡Hola!", ni ningún tipo de saludo. Jamás. Bajo ninguna circunstancia. Tus respuestas arrancan directo con la información que el cliente necesita, sin preámbulos ni frases de apertura. El cliente ya está en medio de una conversación.

Reglas:
- Respondé en español argentino, con tono cordial y profesional.
- Usá SOLO los datos que te paso abajo. No inventes precios, productos ni información.
- Si la información que te doy no alcanza para responder, decilo honestamente: "No tengo ese dato, un agente te lo confirma."
- Sé breve, estás en WhatsApp. Máximo 3-4 oraciones.
- Si el cliente pregunta algo que no está en los datos, ofrecé derivarlo a un agente humano.
- Si en los DATOS dice que hay una LISTA DE PRECIOS para enviar, decí algo como "Ahí te mando la lista!" sin repetir los precios (van en la imagen). Solo agregá info breve útil.
- PRECIOS_SUGERIDOS es la única fuente válida de precios. Usá los precios listados tal cual, nunca recalcules ni inventes. Si precio_unitario tiene un valor numérico, ese producto SI tiene precio y debes informarlo. Si precio_unitario=FALTANTE, entonces si deci que un agente lo cotiza. Si la medida_referencia es diferente a la medida_solicitada, informa el precio y aclara el ajuste. Si hay varias variantes listadas para la misma medida_solicitada, mostralas todas y pregunta cual quiere.
- Si PRECIOS_SUGERIDOS NO aparece en los DATOS, no hay productos que coincidan con la consulta. NO inventes precios ni nombres de productos. Deci: "No encontre ese producto en el catalogo, un agente te puede ayudar." No menciones precios que no esten en los datos.
- Si el usuario dice "agregalo", "si", "dale" o similares como respuesta a un producto que vos mencionaste, NO digas que lo agregaste al pedido. El sistema no puede agregar productos en base a respuestas afirmativas. Decile: "Decime el producto completo con sus medidas para que pueda agregarlo a tu pedido."
- Si el usuario te pide el presupuesto, quiere ver el total de su pedido, o confirma que quiere comprar, podés incluir [[SHOW_BUDGET]] en tu respuesta. El sistema lo reemplazará automáticamente con el presupuesto formateado. Todo lo que escribas además del sentinel también se enviará.
- Si el usuario quiere cancelar o abandonar su pedido, decile que use las palabras "cancelar pedido" o "abandonar carrito" para borrarlo y empezar de nuevo.
- DIFERENCIACIÓN — HANDOFF: si el cliente pide descuento, coordinar entrega/retiro, hace un reclamo, da una dirección de entrega, o toma cualquier decisión de negocio que no sea consultar datos de catálogo (precios, medidas, variantes), respondé UNICAMENTE con [[HANDOFF]] y nada más. No intentes negociar ni coordinar.

DATOS DEL SISTEMA:`

function lastUserMeasure(historyText: string): string | null {
  const userLines = historyText.split('\n').filter(l => l.startsWith('Usuario:'))
  for (let i = userLines.length - 1; i >= 0; i--) {
    const m = userLines[i].match(/\b(\d+)\s*(?:[xX×]|por)\s*(\d+)\b/)
    if (m) {
      const a = parseInt(m[1], 10)
      const b = parseInt(m[2], 10)
      return `${Math.min(a, b)}x${Math.max(a, b)}`
    }
  }
  return null
}

function lastUserQuantityForMeasure(historyText: string, category: string, medida: string): number | null {
  const userLines = historyText.split('\n').filter(l => l.startsWith('Usuario:'))
  for (let i = userLines.length - 1; i >= 0; i--) {
    const line = userLines[i]
    const qMatch = line.match(/\b(\d+)\s*(?:bastidor|acr[ií]lico|circular|rollo|tela)/i)
    if (qMatch) {
      const dimMatch = line.match(/\b(\d+)\s*[xX×]\s*(\d+)\b/)
      if (!dimMatch) return parseInt(qMatch[1], 10)
      const a = parseInt(dimMatch[1], 10)
      const b = parseInt(dimMatch[2], 10)
      const lineMeasure = `${Math.min(a, b)}x${Math.max(a, b)}`
      if (lineMeasure === medida) return parseInt(qMatch[1], 10)
    }
  }
  return null
}

function detectIntent(text: string): DetectedIntent {
  const t = text.toLowerCase()

  if (/\bconfirmar pedido|confirmar peido|confirmo pedido|confirmo peido|confirma pedido|confirmado|confirmar compra|ya confirma|ya confirmo\b/.test(t)) {
    return { intent: 'confirm_order' }
  }

  if (/\b(factura|deuda|saldo|debo|debe|pendiente|pago|pagar|cuenta|vencimiento)\b/.test(t)) {
    return { intent: 'pending_invoices' }
  }

  // Order request: user wants to buy (after getting a price)
  if (/\b(quiero pedir|d[aá]melo|lo quiero|lo compro|encargar|pedir este|comprar|encargame|haceme uno)\b/.test(t)) {
    return { intent: 'order_request' }
  }

  const hasDim = /(\d+)\s*(?:[xX×]|por)\s*(\d+)/.test(t) || /\d+\s*(?:cm|cc)\b/.test(t)

  const hasLista = /\b(lista|cat[áa]logo)\b/.test(t)
  let priceListCategory: string | undefined
  if (/acr[ií]lico/.test(t)) priceListCategory = 'acrilicos'
  if (/circular/.test(t)) priceListCategory = 'circulares'
  if (/bastidor/.test(t)) priceListCategory = 'bastidores'

  if (hasLista) return { intent: 'price_list', priceListCategory }

  const productMatch = /\b(bastidor|acr[ií]lico|circular|tapacanto|pintura|lienzo|tela|lona|varilla|moldura|rollo|embastar|marcos?|molduras?)\b/.test(t)
  const priceWords = /\b(precios?|cuest[ao]|sale|cu[aá]nto|valor)\b/.test(t)

  // "quiero/queria/quisiera/necesito" + producto + dimensiones (sin palabras de precio) → order_request
  const buyIntent = /\b(quiero|quer[ií]a|quisiera|necesito)\b/.test(t) && !priceWords
  if (buyIntent && productMatch && hasDim) {
    return { intent: 'order_request' }
  }

  if (priceWords && priceListCategory && !hasDim) {
    return { intent: 'price_list', priceListCategory }
  }

  if (priceWords && !hasDim && !productMatch) {
    return { intent: 'price_list' }
  }

  if (productMatch) return { intent: 'product_search' }
  if (priceWords && hasDim) return { intent: 'product_search' }

  // Cancel order: user wants to abandon/clear the cart
  if (/\b(cancelar|abandonar|anular|borrar|eliminar|vaciar|me equivoqu[eé])\b/.test(t) && /\b(pedido|carrito|compra|presupuesto)\b/.test(t)) {
    return { intent: 'cancel_order' }
  }
  if (/\b(empezar de nuevo|nuevo pedido|olvid[aá] lo|olvid[aá]lo)\b/.test(t)) {
    return { intent: 'cancel_order' }
  }

  // View budget: user wants to see current cart/budget
  if (/\bpresupuesto\b/.test(t)) {
    return { intent: 'view_budget' }
  }

  const words = t.replace(/[^\w\s]/g, ' ').trim().split(/\s+/).filter(Boolean)
  const greetingPattern = /^(hola|gracias|ok|dale|bueno|bien|genial|perfecto|chau|adios|buen|buenas|buenos|okey|listo|excelente|buend[ií]a)$/
  if (words.length <= 2 && words.every(w => greetingPattern.test(w))) {
    return { intent: 'ignore' }
  }

  return { intent: 'general' }
}

async function getPendingGreeting(phone: string, accountId: string): Promise<string | null> {
  try {
    const db = supabaseAdmin()
    const { data } = await db
      .from('chatbot_logs')
      .select('created_at, data')
      .eq('phone', phone)
      .eq('account_id', accountId)
      .eq('step', 'intent_detected')
      .order('created_at', { ascending: false })
      .limit(1)

    if (!data || data.length === 0) return null

    const log = data[0]
    const logData = log.data as Record<string, unknown> | null
    if (logData?.intent !== 'ignore') return null

    const ts = new Date(log.created_at as string).getTime()
    if (Date.now() - ts > 30 * 60 * 1000) return null

    return 'SALUDO PENDIENTE: El usuario te saludó antes y no le respondiste. Arrancá preguntándole si tenía una consulta.'
  } catch {
    return null
  }
}

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

function formatSugerencias(sugerencias: SugerenciaPrecio[]): string {
  return sugerencias
    .map(s => `- ${s.categoria} ${s.medida}${s.variante ? ` (${s.variante})` : ''}: $${s.precio.toLocaleString('es-AR')}`)
    .join('\n')
}

function formatOrderContext(ctx: Record<string, unknown> | null): string {
  if (!ctx) return ''
  const cart = (ctx.cart ?? ctx.presupuesto_activo ?? ctx.pedido_confirmado) as CartState | undefined
  if (cart?.items?.length) return formatCartForLLM(cart)
  return ''
}

async function loadLastMessages(conversationId: string, limit: number = 4): Promise<string> {
  try {
    const db = supabaseAdmin()
    const { data } = await db
      .from('messages')
      .select('content_text, sender_type')
      .eq('conversation_id', conversationId)
      .eq('content_type', 'text')
      .order('created_at', { ascending: false })
      .limit(limit)

    if (!data || data.length === 0) return ''

    const reversed = [...data].reverse()
    return reversed
      .map(m => `${m.sender_type === 'customer' ? 'Usuario' : 'Bot'}: ${m.content_text?.slice(0, 200)}`)
      .join('\n')
  } catch {
    return ''
  }
}

async function getClientInfo(contactId: string, accountId: string): Promise<{ name: string; phone: string } | null> {
  try {
    const db = supabaseAdmin()
    const { data } = await db
      .from('contacts')
      .select('name, phone')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!data) return null
    return { name: data.name || 'Cliente', phone: data.phone || '' }
  } catch {
    return null
  }
}

async function sendImage(
  ctx: { accountId: string; userId: string; contactId: string; conversationId: string },
  imageUrl: string,
  caption: string,
): Promise<boolean> {
  let attempt = 0
  while (attempt < 2) {
    try {
      await engineSendMedia({
        accountId: ctx.accountId,
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        contactId: ctx.contactId,
        kind: 'image',
        link: imageUrl,
        caption,
      })
      console.log('[chatbot] Image sent OK')
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[chatbot] Image send failed (attempt %d):', attempt + 1, msg)
      attempt++
      if (attempt >= 2) return false
      await new Promise(r => setTimeout(r, 3000))
    }
  }
  return false
}

// ─── LLM Extraction: interpreta el mensaje y decide acción ───

export interface ExtractionProduct {
  categoria: string
  medida: string
  variante: string | null
  cantidad: number
  regla: string | null
}

export interface ExtractionResult {
  accion: 'add_to_cart' | 'view_budget' | 'confirm_order' | 'cancel_order' | 'price_query' | 'handoff' | 'general' | 'ignore'
  productos: ExtractionProduct[]
  confianza: 'alta' | 'baja'
  mensaje_provisional: string | null
}

export const EXTRACTION_PROMPT = `Sos un extractor de pedidos para Bastidores GAL, taller de marcos y molduras.
Tu trabajo: analizar el mensaje del cliente y devolver UNICAMENTE un JSON con la accion y los productos que entendiste.

ACCIONES posibles:
- "add_to_cart": el cliente quiere agregar productos al carrito
- "price_query": el cliente pregunta precios sin necesariamente querer comprar ya
- "view_budget": el cliente quiere ver su presupuesto actual
- "confirm_order": el cliente confirma el pedido (frases como "dale", "si", "joya", "mandalo", "confirmar pedido")
- "cancel_order": el cliente quiere cancelar o abandonar el pedido
- "handoff": el cliente pide descuento, coordinacion de entrega/retiro, reclamo, direccion, pago, horario
- "general": saludo, pregunta generica, o no entendiste
- "ignore": mensaje vacio o irrelevante

PRODUCTOS: array de objetos con:
- categoria: "bastidor" | "acrilicos" | "circulares" | "producto"
- medida: string (ej: "100x120", "180cm x 1.30cm")
- variante: "Sin Tela" | "Lienzo Profesional" | "Lona Preparada" | "Doble 4cm" | null
- cantidad: numero (default 1)
- regla: "pintura" | "tapacanto" | null (si menciona "pintura", "embastar", "reembastar" -> regla: "pintura"; si menciona "tapacanto", "marco" -> regla: "tapacanto")

CONFIANZA: "alta" si estas seguro de todos los datos; "baja" si hay ambiguedad (ej: "creo que era sin tela").

REGLAS IMPORTANTES:
- PRIORIDAD #1: INFERIR MEDIDA DEL HISTORIAL. Si el cliente menciona una variante (ej: "lienzo profesional", "sin tela", "lona preparada", "doble 4cm") sin decir la medida, revisá el HISTORIAL. Buscá la última medida que el bot mencionó o cotizó. Si el bot acaba de listar variantes para "100x120", y el cliente dice "quiero de lienzo profesional", la medida es "100x120". NUNCA dejes medida vacía si el historial tiene una medida clara.
- PRIORIDAD #2: HEREDAR CANTIDAD del historial. Si el cliente elige una variante de algo que pidió ANTES con una cantidad (ej: "Quiero 2 bastidores 45x36" → luego "quiero el de doble 4cm"), la cantidad debe ser la del mensaje original del USUARIO, no 1. Buscá en el historial cuántos pidió para esa medida/categoría.
- "agregalo", "agregalo y pasame el presupuesto", "agregalo al pedido": si el bot acaba de cotizar algo en los mensajes anteriores y el cliente dice esto, eso es accion: "add_to_cart" con el producto que el bot cotizó. No es view_budget. Extraé los datos del historial.
- Si el cliente dice "agregame 2 mas iguales", mira el carrito o los ultimos mensajes para deducir el producto.
- Formatos de medida a normalizar: "100x0,60" -> "100x60", "180cm x 1.30cm" -> "130x180" (el numero mayor primero, ignorar unidades). Ordena siempre chico x grande.
- Confirmaciones casuales ("dale", "joya, mandalo", "de una") SON confirm_order. Pero si no estas seguro, usa confianza: "baja".
- "reembastar" es lo mismo que "pintura" -> categoria: "bastidor", regla: "pintura", variante: "Sin Tela".
- Si el cliente pregunta por algo que claramente no es un bastidor/acrilico/circular (ej: "Papel Arches", "pinceles"), usa accion: "general" y el sistema le dira que no lo tiene.
- confianza: "baja" si tuviste que inferir la medida del historial sin estar 100% seguro. confianza: "baja" si la medida no aparece ni en el mensaje ni en el historial (en ese caso usá medida: "").

FEW-SHOT EXAMPLES:

Mensaje: "Hola quiero un bastidor de 100 x 120 sin tela"
{"accion":"add_to_cart","productos":[{"categoria":"bastidor","medida":"100x120","variante":"Sin Tela","cantidad":1,"regla":null}],"confianza":"alta","mensaje_provisional":null}

Mensaje: "Dame Sin tela" (historial: el bot acaba de listar variantes de 100x120)
{"accion":"add_to_cart","productos":[{"categoria":"bastidor","medida":"100x120","variante":"Sin Tela","cantidad":1,"regla":null}],"confianza":"alta","mensaje_provisional":null}

Mensaje: "quiero de lienzo profesional" (historial: el bot listó variantes Lienzo Profesional, Lona Preparada, Sin Tela para 100x120)
{"accion":"add_to_cart","productos":[{"categoria":"bastidor","medida":"100x120","variante":"Lienzo Profesional","cantidad":1,"regla":null}],"confianza":"baja","mensaje_provisional":null}

Mensaje: "la de lona preparada porfa" (historial: el bot acaba de cotizar 100x120 con variantes)
{"accion":"add_to_cart","productos":[{"categoria":"bastidor","medida":"100x120","variante":"Lona Preparada","cantidad":1,"regla":null}],"confianza":"baja","mensaje_provisional":null}

Mensaje: "me lo das sin tela" (historial: el bot ofreció variantes para 190x120)
{"accion":"add_to_cart","productos":[{"categoria":"bastidor","medida":"190x120","variante":"Sin Tela","cantidad":1,"regla":null}],"confianza":"baja","mensaje_provisional":null}

Mensaje: "quiero el de doble 4cm" (historial: usuario dijo "Quiero 2 bastidores 45 x 36", el bot listó variantes)
{"accion":"add_to_cart","productos":[{"categoria":"bastidor","medida":"36x45","variante":"Doble 4cm","cantidad":2,"regla":null}],"confianza":"baja","mensaje_provisional":null}

Mensaje: "agregalo y pasame el presupuesto" (historial: el bot cotizó "Rollo de tela profesional 2x5 metros: $180.000. ¿Querés agregarlo?")
{"accion":"add_to_cart","productos":[{"categoria":"producto","medida":"2x5","variante":null,"cantidad":1,"regla":null}],"confianza":"baja","mensaje_provisional":null}

Mensaje: "el de 2 x 5" (historial: el bot listó rollos de tela 1.5x5, 2x5, 2x4)
{"accion":"add_to_cart","productos":[{"categoria":"producto","medida":"2x5","variante":null,"cantidad":1,"regla":null}],"confianza":"baja","mensaje_provisional":null}

Mensaje: "3 bastidores vacios de 100x0,60"
{"accion":"add_to_cart","productos":[{"categoria":"bastidor","medida":"60x100","variante":null,"cantidad":3,"regla":null}],"confianza":"alta","mensaje_provisional":null}

Mensaje: "reembastar 4 obras de 95x68 cm"
{"accion":"add_to_cart","productos":[{"categoria":"bastidor","medida":"68x95","variante":"Sin Tela","cantidad":4,"regla":"pintura"}],"confianza":"alta","mensaje_provisional":null}

Mensaje: "cuanto esta un rollo de tela de 2 x 5?"
{"accion":"price_query","productos":[{"categoria":"producto","medida":"2x5","variante":null,"cantidad":1,"regla":null}],"confianza":"alta","mensaje_provisional":null}

Mensaje: "Si quiero agregar el 120 x 123 Lienzo Profesional, despues quiero un tapacanto de 120 x 123 y una bastidor de 145 x 156 sin tela"
{"accion":"add_to_cart","productos":[{"categoria":"bastidor","medida":"120x123","variante":"Lienzo Profesional","cantidad":1,"regla":null},{"categoria":"bastidor","medida":"120x123","variante":"Lienzo Profesional","cantidad":1,"regla":"tapacanto"},{"categoria":"bastidor","medida":"145x156","variante":"Sin Tela","cantidad":1,"regla":null}],"confianza":"alta","mensaje_provisional":null}

Mensaje: "dale mandalo"
{"accion":"confirm_order","productos":[],"confianza":"alta","mensaje_provisional":null}

Mensaje: "joya, tráiganlo así"
{"accion":"confirm_order","productos":[],"confianza":"alta","mensaje_provisional":null}

Mensaje: "si dale"
{"accion":"confirm_order","productos":[],"confianza":"baja","mensaje_provisional":null}

Mensaje: "cancelar pedido"
{"accion":"cancel_order","productos":[],"confianza":"alta","mensaje_provisional":null}

Mensaje: "cual es el total?"
{"accion":"view_budget","productos":[],"confianza":"alta","mensaje_provisional":null}

Mensaje: "hacen envios a Cordoba?"
{"accion":"handoff","productos":[],"confianza":"alta","mensaje_provisional":null}

Mensaje: "me haces un descuento?"
{"accion":"handoff","productos":[],"confianza":"alta","mensaje_provisional":null}

DEVOLVE SOLO EL JSON, NADA MAS.`

export async function extractAction(
  historyText: string,
  cart: CartState | undefined,
  currentMessage: string,
  accountId: string,
): Promise<ExtractionResult | null> {
  const userPrompt = [
    cart ? `CARRITO: ${JSON.stringify({ items: cart.items.length, total: cart.total, status: cart.status })}` : 'CARRITO: vacio',
    historyText ? `HISTORIAL:\n${historyText}` : '',
    `MENSAJE ACTUAL: ${currentMessage}`,
  ].filter(Boolean).join('\n\n')

  console.log(`[extractAction] calling OpenRouter model=${DEFAULT_CHAT_MODEL} promptLen=${userPrompt.length}B`)

  try {
    const t0 = Date.now()
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.VERCEL_PROJECT_PRODUCTION_URL || 'http://localhost:3000',
        'X-Title': 'BastidoresGAL',
      },
      body: JSON.stringify({
        model: DEFAULT_CHAT_MODEL,
        messages: [
          { role: 'system', content: EXTRACTION_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.1,
        max_tokens: 600,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    console.log(`[extractAction] OpenRouter response status=${response.status} t=${Date.now()-t0}ms`)

    if (!response.ok) {
      console.error('[extractAction] OpenRouter error:', response.status)
      return null
    }

    const data = await response.json()
    const raw = data.choices?.[0]?.message?.content?.trim() || ''
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      console.error('[extractAction] No JSON found in response:', raw.slice(0, 200))
      return null
    }

    const parsed = JSON.parse(jsonMatch[0])
    return {
      accion: parsed.accion || 'general',
      productos: Array.isArray(parsed.productos) ? parsed.productos : [],
      confianza: parsed.confianza === 'baja' ? 'baja' : 'alta',
      mensaje_provisional: parsed.mensaje_provisional || null,
    }
  } catch (err) {
    console.error('[extractAction] Failed:', err instanceof Error ? err.message : String(err))
    return null
  }
}

export async function processChatMessage(args: ChatArgs): Promise<void> {
  if (!CHATBOT_ENABLED) {
    console.log('[chatbot] SKIPPED — CHATBOT_ENABLED=false')
    return
  }
  const { text, phone, accountId, userId, contactId, conversationId } = args
  const sendCtx = { accountId, userId, contactId, conversationId }
  const t0 = Date.now()
  const pfmt = (extra: string) => `[chatbot] phone=${phone.slice(-6)} | msg=${JSON.stringify(text.slice(0, 50))} | ${extra} | t=${Date.now() - t0}ms`

  console.log(pfmt(`START`))

  // Step 1 — Hard handoff for non-catalog topics (regex, always first)
  const handoffPattern = shouldHardHandoff(text)
  if (handoffPattern) {
    logChatbotStep({
      phone, message_text: text,
      step: 'handoff',
      data: { reason: `hard-handoff: ${handoffPattern}` },
      account_id: accountId,
    }).catch(() => {})
    try {
      const db = supabaseAdmin()
      await db.from('conversations').update({ status: 'pending', ai_autoreply_disabled: true }).eq('id', conversationId)
    } catch { /* non-critical */ }
    console.log(pfmt(`action=handoff hard=${handoffPattern}`))
    return
  }
  console.log(pfmt(`step1=no-handoff`))

  // Step 2 — Check for pending greeting (user said hi but was ignored)
  const greeting = await getPendingGreeting(phone, accountId)
  console.log(pfmt(`step2=greeting greeting=${greeting ? 'found' : 'none'}`))

  // Load conversation context: order state + last messages
  let orderContext: Record<string, unknown> | null = null
  let historyText = ''
  try {
    const db = supabaseAdmin()
    const { data: conv } = await db
      .from('conversations')
      .select('order_context')
      .eq('id', conversationId)
      .maybeSingle()
    orderContext = (conv?.order_context as Record<string, unknown>) ?? null
    historyText = await loadLastMessages(conversationId, 15)
  } catch {
    console.log(pfmt(`step2=context-load-failed`))
    // non-critical, continue without context
  }

  console.log(pfmt(`step2=context orderCtx=${orderContext ? 'has' : 'none'} history=${historyText.length}B`))

  // ── LLM EXTRACTION: reemplaza detectIntent + suggestPrice ──
  const cart = (orderContext?.cart ?? orderContext?.presupuesto_activo) as CartState | undefined
  let extractionUsed = false

  try {
    console.log(pfmt(`step3=extractAction-start cart=${cart?.items?.length ?? 0}items`))
    const extraction = await extractAction(historyText, cart, text, accountId)
    console.log(pfmt(`step3=extractAction-done result=${extraction?.accion ?? 'null'}`))

    if (extraction && extraction.accion !== 'general' && extraction.accion !== 'ignore') {
      extractionUsed = true
      logChatbotStep({
        phone, message_text: text,
        step: 'extraction',
        data: { accion: extraction.accion, productos: extraction.productos.length, confianza: extraction.confianza },
        account_id: accountId,
      }).catch(() => {})

      // ── EXECUTE EXTRACTED ACTION ──

      if (extraction.accion === 'handoff') {
        try {
          const db = supabaseAdmin()
          await db.from('conversations').update({ status: 'pending', ai_autoreply_disabled: true }).eq('id', conversationId)
        } catch { /* non-critical */ }
        const handoffMsg = extraction.mensaje_provisional || 'Te derivo con un agente para ayudarte mejor.'
        await reply(sendCtx, handoffMsg)
        console.log(pfmt(`intent=extraction action=handoff`))
        return
      }

      if (extraction.accion === 'cancel_order') {
        try {
          const db = supabaseAdmin()
          await db.from('conversations').update({ order_context: null }).eq('id', conversationId)
        } catch { /* non-critical */ }
        await reply(sendCtx, 'Pedido cancelado. Si querés empezar de nuevo, decime qué necesitás.')
        console.log(pfmt(`intent=extraction action=cancel_order`))
        return
      }

      if (extraction.accion === 'view_budget') {
        if (cart?.items?.length) {
          const client = await getClientInfo(contactId, accountId)
          const budgetMsg = formatCartBudget(cart, client?.name || 'Cliente', client?.phone || phone)
          await reply(sendCtx, budgetMsg)
          console.log(pfmt(`intent=extraction action=view_budget`))
          return
        }
        await reply(sendCtx, 'Todavía no tenés productos en tu pedido. Decime qué querés y te paso los precios.')
        console.log(pfmt(`intent=extraction action=view_budget empty`))
        return
      }

      if (extraction.accion === 'confirm_order') {
        if (!cart?.items?.length) {
          await reply(sendCtx, 'No tenés un pedido activo para confirmar. Decime qué querés pedir.')
          return
        }
        // If pending_confirm is already set, this IS the user's response to our repregunta — confirm regardless
        if (cart.pending_confirm) {
          cart.status = 'confirmado'
          cart.pending_confirm = false
          try {
            const db = supabaseAdmin()
            await db.from('conversations').update({
              status: 'pending',
              ai_autoreply_disabled: true,
              order_context: { ...(orderContext || {}), cart },
            }).eq('id', conversationId)
          } catch { /* non-critical */ }
          await reply(sendCtx, '¡Gracias! Tu pedido fue registrado. Un agente se va a comunicar para coordinar la entrega.')
          logChatbotStep({ phone, message_text: text, step: 'handoff', data: { reason: 'order confirmed (pending response)', cart }, account_id: accountId }).catch(() => {})
          console.log(pfmt(`intent=extraction action=confirm_order pending_resolved=true cart=${cart.items.length}items $${cart.total}`))
          return
        }
        // Not pending yet — if confidence is low, ask before confirming
        if (extraction.confianza === 'baja') {
          cart.pending_confirm = true
          try {
            const db = supabaseAdmin()
            await db.from('conversations').update({
              order_context: { ...orderContext, cart },
            }).eq('id', conversationId)
          } catch { /* non-critical */ }
          await reply(sendCtx, `¿Confirmás el pedido? Tenés ${cart.items.length} producto(s) por $${cart.total.toLocaleString('es-AR')}. Respondé "si" para confirmar.`)
          console.log(pfmt(`intent=extraction action=confirm_order pending_set=true`))
          return
        }
        // High confidence, not pending → confirm directly
        cart.status = 'confirmado'
        try {
          const db = supabaseAdmin()
          await db.from('conversations').update({
            status: 'pending',
            ai_autoreply_disabled: true,
            order_context: { ...(orderContext || {}), cart },
          }).eq('id', conversationId)
        } catch { /* non-critical */ }
        await reply(sendCtx, '¡Gracias! Tu pedido fue registrado. Un agente se va a comunicar para coordinar la entrega.')
        logChatbotStep({ phone, message_text: text, step: 'handoff', data: { reason: 'order confirmed by extraction', cart }, account_id: accountId }).catch(() => {})
        console.log(pfmt(`intent=extraction action=confirm_order cart=${cart.items.length}items $${cart.total}`))
        return
      }

      // add_to_cart / price_query — necesita pricing del backend
      if ((extraction.accion === 'add_to_cart' || extraction.accion === 'price_query') && extraction.productos.length > 0) {
        for (const p of extraction.productos) {
          if (!p.medida || !p.medida.trim()) {
            const userMeasure = lastUserMeasure(historyText)
            if (userMeasure) {
              p.medida = userMeasure
              console.log(pfmt(`step3=extractAction resolved medida=${p.medida} from user-history`))
            } else if (cart?.items?.length) {
              p.medida = cart.items[cart.items.length - 1].medida
              console.log(pfmt(`step3=extractAction resolved medida=${p.medida} from cart`))
            }
          }
          if (p.cantidad <= 1 && !/\d+\s*(?:bastidor|acr[ií]lico|circular|unidad|rollo)/i.test(text)) {
            const inheritedQty = cart?.items?.length
              ? null
              : lastUserQuantityForMeasure(historyText, p.categoria, p.medida)
            if (inheritedQty && inheritedQty > 1) {
              p.cantidad = inheritedQty
              console.log(pfmt(`step3=extractAction resolved cantidad=${p.cantidad} from user-history`))
            }
          }
        }

        const bulkItems: BulkPriceItem[] = extraction.productos.map(p => ({
          categoria: p.categoria,
          medida: p.medida,
          variante: p.variante,
          cantidad: p.cantidad || 1,
          regla: p.regla,
        }))

        let pricingResult: BulkPriceResult
        try {
          pricingResult = await bulkPrice(bulkItems)
        } catch (err) {
          console.error('[chatbot] bulkPrice failed:', err)
          // Fall through to old flow
          extractionUsed = false
        }

        if (extractionUsed) {
          logChatbotStep({
            phone, message_text: text,
            step: 'bulk_price',
            data: { items: pricingResult!.items.length, sugerencias: pricingResult!.sugerencias.length },
            account_id: accountId,
          }).catch(() => {})

          // Build cart from pricing result
          const pricedItems = pricingResult!.items.map(d => ({
            cantidad: d.cantidad,
            categoria: d.categoria,
            medida: d.medida_solicitada,
            variante: d.variante,
            precio: d.precio,
            faltante: d.faltante,
          }))

          if (pricedItems.length > 0 && extraction.accion === 'add_to_cart') {
            const newCart = cart?.items?.length
              ? addToCart(cart, pricedItems)
              : createCart(pricedItems)
            if (extraction.confianza === 'baja') {
              newCart.pending_confirm = true
            }
            try {
              const db = supabaseAdmin()
              await db.from('conversations').update({
                order_context: { ...orderContext, cart: newCart },
              }).eq('id', conversationId)
              orderContext = { ...orderContext, cart: newCart }
            } catch { /* non-critical */ }
          }

          // Build dataContext from pricing result
          let dataContext = ''
          if (pricingResult!.items.length > 0) {
            dataContext += '\nPRECIOS_SUGERIDOS\n'
            pricingResult!.items.forEach((d, i) => {
              dataContext += `ITEM ${i + 1}\n`
              dataContext += `  cantidad=${d.cantidad}\n`
              dataContext += `  categoria=${d.categoria}\n`
              dataContext += `  variante=${d.variante || '-'}\n`
              dataContext += `  medida_solicitada=${d.medida_solicitada}\n`
              dataContext += `  medida_referencia=${d.medida_referencia}\n`
              dataContext += `  precio_unitario=${d.precio ?? 'FALTANTE'}\n`
            })
            dataContext += '\n'
          }
          if (pricingResult!.mensaje) {
            dataContext += `${pricingResult!.mensaje}\n`
          }
          if (extraction.mensaje_provisional) {
            dataContext += `MENSAJE PROVISIONAL: ${extraction.mensaje_provisional}\n`
          }

          // Cart context
          const contextOrder = formatOrderContext(orderContext)
          if (contextOrder) {
            dataContext = contextOrder + '\n\n' + dataContext
          }
          if (historyText) {
            dataContext = 'ÚLTIMOS MENSAJES:\n' + historyText + '\n\n' + dataContext
          }
          if (greeting) {
            dataContext = greeting + '\n\n' + dataContext
          }

          if (!dataContext.trim()) {
            console.log(pfmt(`intent=extraction action=no_data`))
            return
          }

          // LLM response generation
          try {
            const result = await callOpenRouter({
              systemPrompt: CHAT_SYSTEM_PROMPT + '\n\n' + dataContext,
              userMessage: text,
            })
            let respuesta = result.text
            const usage = result.usage

            if (respuesta.includes(HANDOFF_SENTINEL)) {
              try {
                const db = supabaseAdmin()
                await db.from('conversations').update({ status: 'pending', ai_autoreply_disabled: true }).eq('id', conversationId)
              } catch { /* non-critical */ }
              console.log(pfmt(`intent=extraction action=handoff llm_sentinel`))
              return
            }

            if (respuesta.includes(SHOW_BUDGET_SENTINEL)) {
              const budgetCart = (orderContext?.cart ?? orderContext?.presupuesto_activo) as CartState | undefined
              if (budgetCart?.items?.length) {
                const client = await getClientInfo(contactId, accountId)
                const budgetText = formatCartBudget(budgetCart, client?.name || 'Cliente', client?.phone || phone)
                respuesta = respuesta.replace(SHOW_BUDGET_SENTINEL, '\n\n' + budgetText)
              } else {
                respuesta = respuesta.replace(SHOW_BUDGET_SENTINEL, '\n\nTodavía no tenés productos en tu pedido.')
              }
            }

            await reply(sendCtx, respuesta)
            logChatbotStep({
              phone, message_text: text,
              step: 'response_sent',
              data: { intent: 'extraction', accion: extraction.accion, response_preview: respuesta.slice(0, 200), tokens_in: usage.prompt_tokens, tokens_out: usage.completion_tokens },
              account_id: accountId,
            }).catch(() => {})

            const nSuggestions = pricingResult!.items.length
            console.log(pfmt(`intent=extraction action=${extraction.accion} suggest=${nSuggestions} cart=${(orderContext as Record<string, unknown>)?.cart ? 'has' : 'empty'}`))
            return
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            console.error(pfmt(`intent=extraction action=error error=${msg}`))
            return
          }
        }
      }
    }
  } catch (e) {
    console.log(pfmt(`step3=extractAction-caught ${e instanceof Error ? e.message : String(e)}`))
    // extraction failed, fall through to old flow
    extractionUsed = false
  }

  // ── FALLBACK: existing regex-based flow ──
  // Only reached if extraction failed or returned general/ignore
  console.log(pfmt(`step4=fallback extractionUsed=${extractionUsed}`))
  const detected = extractionUsed ? { intent: 'general', priceListCategory: undefined } : detectIntent(text)
  const { intent, priceListCategory } = detected as { intent: IntentType; priceListCategory?: string }
  console.log(pfmt(`step4=intent intent=${intent} category=${priceListCategory ?? 'none'}`))

  if (!extractionUsed) {
    logChatbotStep({
      phone, message_text: text,
      step: 'intent_detected',
      data: { intent, priceListCategory: priceListCategory ?? null, conversation_id: conversationId, raw_text: text.slice(0, 100) },
      account_id: accountId,
    }).catch(() => {})
  }

  if (intent === 'ignore' && !extractionUsed) {
    console.log(pfmt(`intent=ignore`))
    return
  }

  if (intent === 'price_list') {
    // Keep price_list flow as-is (list of prices as image)
    // Falls through to Step 3 below
  }

  // ── ORDER FLOW: state-machine via conversation-flow ──
  const flow = determineFlow(cart as { status: string; items?: unknown[] } | undefined, intent, text)

  // show_cart falls through → pricing flow below handles it and appends to cart

  if (flow.action === 'confirm') {
    if (!cart) return
    cart.status = (flow.cartStatus || 'confirmado') as CartState['status']
    logChatbotStep({
      phone, message_text: text,
      step: 'handoff',
      data: { intent, reason: flow.reason, cart },
      account_id: accountId,
    }).catch(() => {})
    try {
      const db = supabaseAdmin()
      await db.from('conversations').update({
        status: 'pending',
        ai_autoreply_disabled: true,
        order_context: { ...(orderContext || {}), cart },
      }).eq('id', conversationId)
    } catch { /* non-critical */ }
    await reply(sendCtx, '¡Gracias! Tu pedido fue registrado. Un agente se va a comunicar para coordinar la entrega.')
    console.log(pfmt(`intent=${intent} action=confirm cart=${cart.items.length}items $${cart.total}`))
    return
  }

  if (flow.action === 'handoff') {
    logChatbotStep({
      phone, message_text: text,
      step: 'handoff',
      data: { intent, reason: flow.reason },
      account_id: accountId,
    }).catch(() => {})
    try {
      const db = supabaseAdmin()
      await db.from('conversations').update({ status: 'pending', ai_autoreply_disabled: true }).eq('id', conversationId)
    } catch { /* non-critical */ }
    console.log(pfmt(`intent=${intent} action=handoff reason=${flow.reason}`))
    return
  }
  // ── END ORDER FLOW ──

  // ── VIEW BUDGET: user asks to see their budget ──
  if (intent === 'view_budget') {
    // Detect if bot recently quoted a product not yet in cart ("¿Querés agregarlo?")
    const lastBotLines = historyText.split('\n').filter(l => l.startsWith('Bot:'))
    const lastBotMsg = lastBotLines[lastBotLines.length - 1] || ''
    if (/\bagregarlo\b/i.test(lastBotMsg) || /\bconfirmo\b.*\bprecio\b/i.test(lastBotMsg)) {
      const priceMatch = lastBotMsg.match(/\$[\d.,]+/)
      if (priceMatch && !/\bno\b.*\bagregar/i.test(text)) {
        const lastUserLine = historyText.split('\n').filter(l => l.startsWith('Usuario:')).pop() || ''
        let searchFor = lastUserLine.replace('Usuario:', '').trim()
        if (!searchFor) searchFor = text
        if (!/\d+\s*[xX×]\s*\d+/.test(searchFor)) {
          const um = lastUserMeasure(historyText)
          if (um) searchFor = `${searchFor} ${um}`
        }
        try {
          const pendingResult = await suggestPrice(searchFor)
          if (pendingResult.items?.length > 0) {
            const newCart = (orderContext?.cart ?? orderContext?.presupuesto_activo) as CartState | undefined
            const updatedCart = newCart?.items?.length
              ? addToCart(newCart, pendingResult.items)
              : createCart(pendingResult.items)
            try {
              const db = supabaseAdmin()
              await db.from('conversations').update({
                order_context: { ...orderContext, cart: updatedCart },
              }).eq('id', conversationId)
              orderContext = { ...orderContext, cart: updatedCart }
              console.log(pfmt(`view_budget auto-added pending product items=${pendingResult.items.length}`))
            } catch { /* non-critical */ }
          }
        } catch (e) {
          console.log(pfmt(`view_budget pending product lookup failed: ${e instanceof Error ? e.message : String(e)}`))
        }
      }
    }

    const budgetCart = (orderContext?.cart ?? orderContext?.presupuesto_activo) as CartState | undefined
    if (budgetCart?.items?.length) {
      const client = await getClientInfo(contactId, accountId)
      budgetCart.status = 'productos_confirmados'
      const budgetMsg = formatCartBudget(budgetCart, client?.name || 'Cliente', client?.phone || phone)
      try {
        const db = supabaseAdmin()
        await db.from('conversations').update({
          order_context: { ...orderContext, cart: budgetCart },
        }).eq('id', conversationId)
      } catch { /* non-critical */ }
      await reply(sendCtx, budgetMsg)
      logChatbotStep({
        phone, message_text: text,
        step: 'response_sent',
        data: { intent, budget_sent: true, cart_status: budgetCart.status },
        account_id: accountId,
      }).catch(() => {})
      console.log(pfmt(`intent=view_budget items=${budgetCart.items.length} total=$${budgetCart.total}`))
      return
    }
    // Empty cart
    await reply(sendCtx, 'Todavía no tenés productos en tu pedido. Decime qué querés y te paso los precios.')
    logChatbotStep({
      phone, message_text: text,
      step: 'response_sent',
      data: { intent, budget_sent: false, reason: 'empty_cart' },
      account_id: accountId,
    }).catch(() => {})
    console.log(pfmt(`intent=view_budget empty`))
    return
  }

  // ── CANCEL ORDER: clear the cart ──
  if (intent === 'cancel_order') {
    const hadCart = !!(orderContext?.cart ?? orderContext?.presupuesto_activo)
    try {
      const db = supabaseAdmin()
      await db.from('conversations').update({ order_context: null }).eq('id', conversationId)
    } catch { /* non-critical */ }
    const msg = hadCart
      ? '✅ Pedido cancelado. Si querés empezar de nuevo, decime qué necesitás.'
      : 'No tenés un pedido activo para cancelar. Decime si querés consultar precios o productos.'
    await reply(sendCtx, msg)
    logChatbotStep({
      phone, message_text: text,
      step: 'response_sent',
      data: { intent, cart_cleared: hadCart },
      account_id: accountId,
    }).catch(() => {})
    console.log(pfmt(`intent=cancel_order cleared=${hadCart}`))
    return
  }

  // Step 5 — Fetch data from FacBal
  console.log(pfmt(`step5=fetch-data intent=${intent}`))
  let dataContext = ''
  let imageUrl: string | null = null
  let imageLabel: string | null = null

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

    if (intent === 'product_search' || intent === 'order_request' || intent === 'general') {
      // Augment variant-only queries with measure from cart or history
      let searchText = text
      const variantKeywords = /\b(lienzo profesional|lona preparada|sin tela|doble 4cm|lienzo|lona)\b/i
      const hasDim = /\d+\s*[xX×]\s*\d+/.test(text)
      const isVariantOnly = variantKeywords.test(text) && !hasDim
      if (isVariantOnly) {
        const userMeasure = lastUserMeasure(historyText)
        const inferredMeasure = userMeasure || (cart?.items?.length ? cart.items[cart.items.length - 1].medida : '')
        if (inferredMeasure) {
          searchText = `${text} ${inferredMeasure}`
          console.log(pfmt(`step5=variant-resolution source=${userMeasure ? 'user-history' : 'cart'} medida=${inferredMeasure} augmented="${searchText}"`))
        }
      }

      // Detect quantity correction: "solo quiero 1 no 4", "es 1 no 4"
      const correctionMatch = text.match(/\b(?:solo\s+(?:quiero|son|es|ped[ií])\s+|es\s+|son\s+)(\d+)\b/i)
      if (correctionMatch && cart?.items?.length) {
        const newQty = parseInt(correctionMatch[1], 10)
        if (newQty > 0 && !hasDim) {
          const lastItem = cart.items[cart.items.length - 1]
          const variantFromText = text.match(/(lienzo profesional|lona preparada|sin tela|doble 4cm)/i)?.[1]
          const targetVariant = variantFromText || lastItem.variante
          if (targetVariant && lastItem.variante?.toLowerCase() === targetVariant?.toLowerCase()) {
            lastItem.cantidad = newQty
            lastItem.subtotal = lastItem.precio_unitario != null ? newQty * lastItem.precio_unitario : null
            cart.total = cart.items.reduce((sum, i) => sum + (i.subtotal || 0), 0)
            try {
              const db = supabaseAdmin()
              await db.from('conversations').update({
                order_context: { ...orderContext, cart },
              }).eq('id', conversationId)
            } catch { /* non-critical */ }
            await reply(sendCtx, `Corregido: ${newQty}x ${lastItem.categoria} ${lastItem.medida}${lastItem.variante ? ` (${lastItem.variante})` : ''}. Total: $${cart.total.toLocaleString('es-AR')}.`)
            logChatbotStep({
              phone, message_text: text,
              step: 'correction',
              data: { intent, old_qty: lastItem.cantidad, new_qty: newQty, item_key: `${lastItem.categoria}|${lastItem.medida}|${lastItem.variante}` },
              account_id: accountId,
            }).catch(() => {})
            console.log(pfmt(`step5=correction qty=${lastItem.cantidad}→${newQty} for ${lastItem.medida}`))
            return
          }
        }
      }

      try {
        let result!: SuggestPriceResult
        let attempt = 0
        while (attempt < 2) {
          try {
            result = await suggestPrice(searchText)
            break
          } catch (err) {
            attempt++
            if (attempt >= 2) throw err
            await new Promise(r => setTimeout(r, 3000))
          }
        }

        logChatbotStep({
          phone,
          message_text: text,
          step: 'suggest_price',
          data: {
            sugerencias_count: result.sugerencias.length,
            medida_encontrada: result.medida_encontrada,
            regla_aplicada: result.regla_aplicada,
            mensaje: result.mensaje,
            intent,
          },
          account_id: accountId,
        }).catch(() => {})

        if (result.items && result.items.length > 0) {
          try {
            const newCart = cart?.items?.length
              ? addToCart(cart, result.items)
              : createCart(result.items)
            const db = supabaseAdmin()
            await db.from('conversations').update({
              order_context: {
                ...orderContext,
                cart: newCart,
              },
            }).eq('id', conversationId)
            orderContext = {
              ...orderContext,
              cart: newCart,
            }
          } catch {
            // non-critical
          }
        }

        if (result.detalles && result.detalles.length > 0) {
          dataContext += '\nPRECIOS_SUGERIDOS\n'
          result.detalles.forEach((d, i) => {
            dataContext += `ITEM ${i + 1}\n`
            dataContext += `  cantidad=${d.cantidad}\n`
            dataContext += `  categoria=${d.categoria}\n`
            dataContext += `  variante=${d.variante || '-'}\n`
            dataContext += `  medida_solicitada=${d.medida_solicitada}\n`
            dataContext += `  medida_referencia=${d.medida_referencia}\n`
            dataContext += `  precio_unitario=${d.precio ?? 'FALTANTE'}\n`
          })
          dataContext += '\n'
          if (result.mensaje) {
            dataContext += `${result.mensaje}\n`
          }
        } else if (result.mensaje) {
          dataContext += `\n${result.mensaje}\n`
          const productos = await buscarProductos(text)
          if (productos.length > 0) {
            dataContext += '\nPRODUCTOS:\n' + formatProductos(productos) + '\n'
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[chatbot] suggestPrice failed:', msg)
        logChatbotStep({
          phone,
          message_text: text,
          step: 'error',
          data: { stage: 'suggestPrice', error: msg },
          account_id: accountId,
        }).catch(() => {})
        try {
          const productos = await buscarProductos(text)
          if (productos.length > 0) {
            dataContext += '\nPRODUCTOS:\n' + formatProductos(productos) + '\n'
          }
        } catch {
          dataContext += '\nPRODUCTOS: Error al consultar\n'
        }
      }
    }

    if (intent === 'price_list') {
      try {
        const images = await getPriceListImages()
        if (images.length > 0) {
          const targetCategory = (priceListCategory || 'bastidores').toLowerCase()
          const match = images.find(img =>
            img.name.toLowerCase().includes(targetCategory) || targetCategory.includes(img.name.toLowerCase()),
          ) || images[0]

          const crmBase = process.env.VERCEL_PROJECT_PRODUCTION_URL
            ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
            : process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
          imageUrl = `${crmBase}/api/price-list-image/${match.id}`
          imageLabel = match.name
          dataContext += `\nLISTA DE PRECIOS: El usuario pidió la lista de precios${priceListCategory ? ` de ${priceListCategory}` : ''}. Vas a enviarle una imagen (${match.name}). Decile algo como "Ahí te mando la lista!" sin repetir precios (ya estan en la imagen). Agregá solo info breve util.\n`
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[chatbot] Price list images failed:', msg)
      }
    }
  } catch (err) {
    console.error('[chatbot] data fetch error:', err)
    return
  }

  const contextOrder = formatOrderContext(orderContext)
  if (contextOrder) {
    dataContext = contextOrder + '\n\n' + dataContext
  }
  if (historyText) {
    dataContext = 'ÚLTIMOS MENSAJES:\n' + historyText + '\n\n' + dataContext
  }
  if (greeting) {
    dataContext = greeting + '\n\n' + dataContext
  }

  if (!dataContext.trim()) {
    logChatbotStep({
      phone,
      message_text: text,
      step: 'no_data',
      data: { intent },
      account_id: accountId,
    }).catch(() => {})
    console.log(pfmt(`intent=${intent} action=no_data`))
    return
  }

  // Step 6 — OpenRouter generates natural response (1 call, all context)
  try {
    const cartSummary = cart?.items?.length ? `${cart.items.length}items $${cart.total}` : 'empty'
    console.log(pfmt(`step6=openrouter ctx=${dataContext.length}B img=${!!imageUrl} cart=${cartSummary}`))
    logChatbotStep({
      phone,
      message_text: text,
      step: 'openrouter_response',
      data: { intent, context_size: dataContext.length, context_preview: dataContext.slice(0, 300), has_image: !!imageUrl },
      account_id: accountId,
    }).catch(() => {})

    const llmResult = await callOpenRouter({
      systemPrompt: CHAT_SYSTEM_PROMPT + '\n\n' + dataContext,
      userMessage: text,
    })
    let respuesta = llmResult.text
    const usage = llmResult.usage

    console.log(pfmt(`step6=openrouter-done tokens_in=${usage.prompt_tokens} tokens_out=${usage.completion_tokens} response=${JSON.stringify(respuesta.slice(0, 80))}`))

    if (respuesta.includes(HANDOFF_SENTINEL)) {
      logChatbotStep({
        phone,
        message_text: text,
        step: 'handoff',
        data: { intent, reason: 'LLM requested handoff' },
        account_id: accountId,
      }).catch(() => {})
      try {
        const db = supabaseAdmin()
        await db.from('conversations').update({
          status: 'pending',
          ai_autoreply_disabled: true,
        }).eq('id', conversationId)
      } catch {
        // non-critical
      }
      console.log(pfmt(`intent=${intent} action=handoff llm_sentinel`))
      return
    }

    // Replace [[SHOW_BUDGET]] with actual budget text
    if (respuesta.includes(SHOW_BUDGET_SENTINEL)) {
      const budgetCart = (orderContext?.cart ?? orderContext?.presupuesto_activo) as CartState | undefined
      if (budgetCart?.items?.length) {
        const client = await getClientInfo(contactId, accountId)
        const budgetText = formatCartBudget(budgetCart, client?.name || 'Cliente', client?.phone || phone)
        respuesta = respuesta.replace(SHOW_BUDGET_SENTINEL, '\n\n' + budgetText)
      } else {
        respuesta = respuesta.replace(SHOW_BUDGET_SENTINEL, '\n\nTodavía no tenés productos en tu pedido. Decime qué querés y te paso los precios.')
      }
    }

    // gemini-2.5-flash-lite: $0.075/1M input, $0.30/1M output
    const costUsd = (usage.prompt_tokens / 1_000_000) * 0.075 + (usage.completion_tokens / 1_000_000) * 0.30

    await reply(sendCtx, respuesta)

    logChatbotStep({
      phone,
      message_text: text,
      step: 'response_sent',
      data: {
        intent,
        response_preview: respuesta.slice(0, 200),
        tokens_in: usage.prompt_tokens,
        tokens_out: usage.completion_tokens,
        cost_usd: Math.round(costUsd * 1_000_000) / 1_000_000,
        has_image: !!imageUrl,
      },
      account_id: accountId,
    }).catch(() => {})

    if (imageUrl) {
      const caption = imageLabel ? `Lista de precios: ${imageLabel}` : 'Lista de precios'
      const imageSent = await sendImage(sendCtx, imageUrl, caption)

      logChatbotStep({
        phone,
        message_text: text,
        step: imageSent ? 'image_sent' : 'image_failed',
        data: { intent, image_url: imageUrl, image_label: imageLabel },
        account_id: accountId,
      }).catch(() => {})
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(pfmt(`intent=${intent} action=error error=${msg}`))
    logChatbotStep({
      phone,
      message_text: text,
      step: 'error',
      data: { stage: 'openrouter_generate', error: msg },
      account_id: accountId,
    }).catch(() => {})
  }

  const nSuggestions = dataContext.includes('PRECIOS_SUGERIDOS')
    ? (dataContext.match(/^ITEM \d+$/gm)?.length ?? 0)
    : 0
  console.log(pfmt(`intent=${intent} action=done suggest=${nSuggestions} cart=${cart?.items?.length ?? 0}items${cart?.total ? ` $${cart.total}` : ''}`))
}
