import { engineSendText, engineSendMedia } from '@/lib/flows/meta-send'
import {
  getFacturasPendientes,
  buscarProductos,
  suggestPrice,
  getPriceListImages,
  getPriceListImageUrl,
  type SugerenciaPrecio,
  type SuggestPriceResult,
  type Producto,
} from '../facbal/client'
import { logChatbotStep } from './chatbot-logger'
import { supabaseAdmin } from './admin-client'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const TIMEOUT_MS = 20_000
const DEFAULT_CHAT_MODEL = 'google/gemini-2.5-flash-lite'

interface ChatArgs {
  text: string
  phone: string
  accountId: string
  userId: string
  contactId: string
  conversationId: string
}

type IntentType = 'pending_invoices' | 'product_search' | 'price_list' | 'general' | 'ignore'

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
- IMPORTANTE: cuando hay precios de referencia mostralos directo, sin explicar redondeos ni cálculos. Ejemplo malo: "no tengo exactamente 41x34, pero tengo 30x40 que sale X". Ejemplo bueno: "Un bastidor 41x34 (equivalente a 30x40) te sale $12.000. También hay estas variantes: ...".

DATOS DEL SISTEMA:`

function detectIntent(text: string): DetectedIntent {
  const t = text.toLowerCase()

  if (/\b(factura|deuda|saldo|debo|debe|pendiente|pago|pagar|cuenta|vencimiento)\b/.test(t)) {
    return { intent: 'pending_invoices' }
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

  console.log('[chatbot] Intent detected: intent=%s category=%s', intent, priceListCategory || '-')

  // Step 2 — Check for pending greeting (user said hi but was ignored)
  const greeting = await getPendingGreeting(phone, accountId)

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

    if (intent === 'product_search' || intent === 'general') {
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

          imageUrl = getPriceListImageUrl(match.id)
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
