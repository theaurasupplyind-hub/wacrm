import { engineSendText, engineSendMedia } from '@/lib/flows/meta-send'
import {
  getFacturasPendientes,
  buscarProductos,
  suggestPrice,
  getPriceListImages,
  type SugerenciaPrecio,
  type SuggestPriceResult,
  type Producto,
} from '../facbal/client'
import { createCart, formatCartForLLM, formatCartBudget, type CartState } from './cart-state'
import { determineFlow } from './conversation-flow'
import { shouldHardHandoff, shouldHandoff } from './handoff-rules'
import { logChatbotStep } from './chatbot-logger'
import { supabaseAdmin } from './admin-client'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const TIMEOUT_MS = 20_000
const DEFAULT_CHAT_MODEL = 'google/gemini-2.5-flash-lite'
const HANDOFF_SENTINEL = '[[HANDOFF]]'

interface ChatArgs {
  text: string
  phone: string
  accountId: string
  userId: string
  contactId: string
  conversationId: string
}

type IntentType = 'pending_invoices' | 'product_search' | 'price_list' | 'order_request' | 'confirm_order' | 'general' | 'ignore'

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

async function callOpenRouter(args: {
  systemPrompt: string
  userMessage: string
}): Promise<{ text: string; usage: { prompt_tokens: number; completion_tokens: number } }> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set')

  const model = process.env.CHATBOT_AI_MODEL || DEFAULT_CHAT_MODEL

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

const CHAT_SYSTEM_PROMPT = `Sos un asistente virtual de Bastidores GAL, un taller de marcos y molduras.

Reglas:
- Respondé en español argentino, con tono cordial y profesional.
- Usá SOLO los datos que te paso abajo. No inventes precios, productos ni información.
- Si la información que te doy no alcanza para responder, decilo honestamente: "No tengo ese dato, un agente te lo confirma."
- Sé breve, estás en WhatsApp. Máximo 3-4 oraciones.
- Si el cliente pregunta algo que no está en los datos, ofrecé derivarlo a un agente humano.
- Si hay una nota de SALUDO PENDIENTE, arrancá saludando y preguntándole si tenía una consulta.
- Si en los DATOS dice que hay una LISTA DE PRECIOS para enviar, decí algo como "Ahí te mando la lista!" sin repetir los precios (van en la imagen). Solo agregá info breve útil.
- IMPORTANTE: cuando hay precios de referencia mostralos directo, sin explicar redondeos ni cálculos. Si un producto aparece como FALTANTE, decile al cliente que ese producto no tiene precio en la tabla y un agente se lo cotiza aparte.
- DIFERENCIACIÓN: si el cliente pide descuento, coordinar entrega/retiro, hace un reclamo, da una dirección de entrega, o toma cualquier decisión de negocio que no sea consultar datos de catálogo (precios, medidas, variantes), respondé UNICAMENTE con [[HANDOFF]] y nada más. No intentes negociar ni coordinar.

DATOS DEL SISTEMA:`

function detectIntent(text: string): DetectedIntent {
  const t = text.toLowerCase()

  if (/\bconfirmar pedido|confirmo pedido|confirmado|confirmar compra\b/.test(t)) {
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

  const words = t.replace(/[^\w\s]/g, ' ').trim().split(/\s+/).filter(Boolean)
  const greetingPattern = /^(hola|gracias|ok|si|s[ií]|dale|bueno|bien|genial|perfecto|chau|adios|buen|buenas|buenos|okey|listo|excelente|buend[ií]a)$/
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

export async function processChatMessage(args: ChatArgs): Promise<void> {
  const { text, phone, accountId, userId, contactId, conversationId } = args
  const sendCtx = { accountId, userId, contactId, conversationId }

  console.log('[chatbot] Processing: "%s" from phone=%s', text.slice(0, 60), phone.slice(-6))

  // Step 1 — Keyword-based intent detection (0 OR calls)
  const detected = detectIntent(text)
  const { intent, priceListCategory } = detected

  logChatbotStep({
    phone,
    message_text: text,
    step: 'intent_detected',
    data: {
      intent,
      priceListCategory: priceListCategory ?? null,
      conversation_id: conversationId,
      raw_text: text.slice(0, 100),
    },
    account_id: accountId,
  }).catch(() => {})

  if (intent === 'ignore') {
    console.log('[chatbot] Ignoring message (intent=ignore)')
    return
  }

  // Step 1.5 — Hard handoff for non-catalog topics
  const handoffPattern = shouldHardHandoff(text)
  if (handoffPattern) {
    logChatbotStep({
      phone, message_text: text,
      step: 'handoff',
      data: { intent, reason: `hard-handoff: ${handoffPattern}` },
      account_id: accountId,
    }).catch(() => {})
    try {
      const db = supabaseAdmin()
      await db.from('conversations').update({ status: 'pending', ai_autoreply_disabled: true }).eq('id', conversationId)
    } catch { /* non-critical */ }
    console.log('[chatbot] END (hard handoff)')
    return
  }

  console.log('[chatbot] Intent detected: intent=%s category=%s', intent, priceListCategory || '-')

  // Step 2 — Check for pending greeting (user said hi but was ignored)
  const greeting = await getPendingGreeting(phone, accountId)

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
    historyText = await loadLastMessages(conversationId, 4)
  } catch {
    // non-critical, continue without context
  }

  // ── ORDER FLOW: state-machine via conversation-flow ──
  const cart = (orderContext?.cart ?? orderContext?.presupuesto_activo) as CartState | undefined
  const flow = determineFlow(cart as { status: string; items?: unknown[] } | undefined, intent, text)

  if (flow.action === 'show_cart' && cart && cart.items?.length) {
    const client = await getClientInfo(contactId, accountId)
    const confirmMsg = formatCartBudget(cart, client?.name || 'Cliente', client?.phone || phone)

    cart.status = (flow.cartStatus || 'productos_confirmados') as CartState['status']
    try {
      const db = supabaseAdmin()
      await db.from('conversations').update({
        order_context: { ...orderContext, cart },
      }).eq('id', conversationId)
    } catch { /* non-critical */ }

    await reply(sendCtx, confirmMsg)
    logChatbotStep({
      phone, message_text: text,
      step: 'response_sent',
      data: { intent, flow_action: flow.action, cart_status: cart.status },
      account_id: accountId,
    }).catch(() => {})
    console.log('[chatbot] END (cart shown)')
    return
  }

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
    console.log('[chatbot] END (order confirmed, handoff)')
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
    console.log('[chatbot] END (handoff)')
    return
  }
  // ── END ORDER FLOW ──

  // Step 3 — Fetch data from FacBal
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
      try {
        let result!: SuggestPriceResult
        let attempt = 0
        while (attempt < 2) {
          try {
            result = await suggestPrice(text)
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
            const newCart = createCart(result.items)
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

        if (result.sugerencias.length > 0) {
          dataContext += `\nPRECIOS DE REFERENCIA:\n${formatSugerencias(result.sugerencias)}\n`
          if (result.regla_aplicada) {
            dataContext += `(Regla aplicada: ${result.regla_aplicada})\n`
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
    console.log('[chatbot] END (no data)')
    return
  }

  // Step 4 — OpenRouter generates natural response (1 call, all context)
  try {
    console.log('[chatbot] Generating response with context size=%d hasImage=%s', dataContext.length, !!imageUrl)
    logChatbotStep({
      phone,
      message_text: text,
      step: 'openrouter_response',
      data: { intent, context_size: dataContext.length, context_preview: dataContext.slice(0, 300), has_image: !!imageUrl },
      account_id: accountId,
    }).catch(() => {})

    const { text: respuesta, usage } = await callOpenRouter({
      systemPrompt: CHAT_SYSTEM_PROMPT + '\n\n' + dataContext,
      userMessage: text,
    })

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
      console.log('[chatbot] END (handoff)')
      return
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
    console.error('[chatbot] Generate response failed:', msg)
    logChatbotStep({
      phone,
      message_text: text,
      step: 'error',
      data: { stage: 'openrouter_generate', error: msg },
      account_id: accountId,
    }).catch(() => {})
  }

  console.log('[chatbot] END intent=%s', intent)
}
