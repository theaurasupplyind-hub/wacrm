import { NextRequest, NextResponse } from 'next/server'
import { shouldHardHandoff } from '@/lib/ai/handoff-rules'
import { HANDOFF_SENTINEL } from '@/lib/ai/defaults'
import {
  extractAction,
  callOpenRouter,
  CHAT_SYSTEM_PROMPT,
  SHOW_BUDGET_SENTINEL,
  type ExtractionResult,
} from '@/lib/ai/chatbot'
import {
  bulkPrice,
  type BulkPriceItem,
  type BulkPriceResult,
} from '@/lib/facbal/client'
import {
  createCart,
  addToCart,
  formatCartBudget,
  formatCartForLLM,
  type CartState,
} from '@/lib/ai/cart-state'
import { buildInvoicePayload, type InvoiceCreatePayload } from '@/lib/ai/build-invoice-payload'

// ─── Tipos del request/response ───

interface SandboxRequest {
  text: string        // mensaje del usuario
  phone: string       // teléfono a simular
  history: { role: 'user' | 'bot'; content: string }[]  // historial de la conversación
  cart: CartState | null  // carrito actual (null si no hay)
}

interface SandboxLog {
  step: string
  data: Record<string, unknown>
}

interface SandboxResponse {
  reply: string
  cart: CartState | null
  invoice: InvoiceCreatePayload | null
  logs: SandboxLog[]
}

// ─── Convierte el historial de la UI al formato que espera el LLM ───
function formatHistoryText(history: { role: string; content: string }[]): string {
  return history
    .map((h) => {
      const label = h.role === 'user' ? 'Usuario' : 'Bot'
      return `${label}: ${h.content}`
    })
    .join('\n')
}

// ─── Arma el dataContext para callOpenRouter igual que chatbot.ts ───
function buildDataContext(args: {
  pricingResult: BulkPriceResult
  historyText: string
  cartText: string
  mensajeProvisional: string | null
}): string {
  let dataContext = ''

  // Contexto del carrito
  if (args.cartText) {
    dataContext = args.cartText + '\n\n'
  }

  // Precios sugeridos desde FacBal
  if (args.pricingResult.items.length > 0) {
    dataContext += 'PRECIOS_SUGERIDOS\n'
    args.pricingResult.items.forEach((d, i) => {
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

  // Mensaje adicional de FacBal
  if (args.pricingResult.mensaje) {
    dataContext += `${args.pricingResult.mensaje}\n`
  }

  // Mensaje provisional del LLM (ej: aclaraciones)
  if (args.mensajeProvisional) {
    dataContext += `MENSAJE PROVISIONAL: ${args.mensajeProvisional}\n`
  }

  // Historial de últimos mensajes
  if (args.historyText) {
    dataContext = 'ÚLTIMOS MENSAJES:\n' + args.historyText + '\n\n' + dataContext
  }

  return dataContext
}

// ─── Handler principal ───

export async function POST(req: NextRequest) {
  const logs: SandboxLog[] = []
  const t0 = Date.now()

  try {
    const body: SandboxRequest = await req.json()
    const { text, phone, history, cart: existingCart } = body

    if (!text || !text.trim()) {
      return NextResponse.json(
        { error: 'El texto del mensaje es obligatorio' },
        { status: 400 },
      )
    }

    // ───── Paso 1: Hard handoff por regex ─────
    const handoffPattern = shouldHardHandoff(text)
    if (handoffPattern) {
      logs.push({ step: 'handoff', data: { reason: `hard-handoff: ${handoffPattern}` } })
      return NextResponse.json({
        reply: 'Te derivo con un agente para ayudarte mejor.',
        cart: existingCart,
        invoice: null,
        logs,
      } satisfies SandboxResponse)
    }

    // ───── Paso 2: Formatear historial para el LLM ─────
    const historyText = formatHistoryText(history)

    // ───── Paso 3: Extraer intención con OpenRouter ─────
    let extraction: ExtractionResult | null = null
    try {
      extraction = await extractAction(
        historyText,
        existingCart ?? undefined,
        text,
        'sandbox',
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logs.push({ step: 'error', data: { stage: 'extractAction', error: msg } })
    }

    logs.push({
      step: 'extraction',
      data: {
        accion: extraction?.accion ?? 'null',
        productos: extraction?.productos?.length ?? 0,
        confianza: extraction?.confianza ?? 'none',
      },
    })

    // ───── Paso 4: Si el LLM no entendió, avisar ─────
    if (!extraction || extraction.accion === 'general' || extraction.accion === 'ignore') {
      return NextResponse.json({
        reply: 'No entendí bien tu consulta. Probá siendo más específico (ej: "quiero 2 bastidores 60x40 sin tela") o escribí "catálogo" para ver la lista de productos.',
        cart: existingCart,
        invoice: null,
        logs,
      } satisfies SandboxResponse)
    }

    // ───── Paso 5: Ejecutar según la acción detectada ─────

    // ─── HANDOFF (detectado por LLM) ───
    if (extraction.accion === 'handoff') {
      const msg = extraction.mensaje_provisional || 'Te derivo con un agente para ayudarte mejor.'
      logs.push({ step: 'handoff', data: { reason: 'llm-handoff' } })
      return NextResponse.json({
        reply: msg,
        cart: existingCart,
        invoice: null,
        logs,
      } satisfies SandboxResponse)
    }

    // ─── CANCELAR PEDIDO ───
    if (extraction.accion === 'cancel_order') {
      logs.push({ step: 'cancel_order', data: {} })
      return NextResponse.json({
        reply: 'Pedido cancelado. Si querés empezar de nuevo, decime qué necesitás.',
        cart: null,
        invoice: null,
        logs,
      } satisfies SandboxResponse)
    }

    // ─── VER PRESUPUESTO ───
    if (extraction.accion === 'view_budget') {
      if (existingCart?.items?.length) {
        const budgetMsg = formatCartBudget(existingCart, `Cliente ${phone}`, phone)
        logs.push({ step: 'view_budget', data: { items: existingCart.items.length, total: existingCart.total } })
        return NextResponse.json({
          reply: budgetMsg,
          cart: existingCart,
          invoice: null,
          logs,
        } satisfies SandboxResponse)
      }
      return NextResponse.json({
        reply: 'Todavía no tenés productos en tu pedido. Decime qué querés y te paso los precios.',
        cart: null,
        invoice: null,
        logs,
      } satisfies SandboxResponse)
    }

    // ─── CONFIRMAR PEDIDO ───
    if (extraction.accion === 'confirm_order') {
      if (!existingCart?.items?.length) {
        return NextResponse.json({
          reply: 'No tenés un pedido activo para confirmar. Decime qué querés pedir.',
          cart: null,
          invoice: null,
          logs,
        } satisfies SandboxResponse)
      }

      // Si ya estábamos esperando confirmación, este es el "sí"
      if (existingCart.pending_confirm) {
        const confirmedCart: CartState = {
          ...existingCart,
          status: 'confirmado',
          pending_confirm: false,
        }
        const invoice = buildInvoicePayload(confirmedCart, phone)
        logs.push({ step: 'confirm_order', data: { items: confirmedCart.items.length, total: confirmedCart.total, invoice_preview: true } })
        return NextResponse.json({
          reply: '✅ Pedido confirmado. Abajo tenés la vista previa del presupuesto que se crearía en FacBal.',
          cart: confirmedCart,
          invoice,
          logs,
        } satisfies SandboxResponse)
      }

      // Si la confianza es baja, preguntar antes de confirmar
      if (extraction.confianza === 'baja') {
        const pendingCart: CartState = {
          ...existingCart,
          pending_confirm: true,
        }
        logs.push({ step: 'pending_confirm', data: { reason: 'baja confianza' } })
        return NextResponse.json({
          reply: `¿Confirmás el pedido? Tenés ${existingCart.items.length} producto(s) por $${existingCart.total.toLocaleString('es-AR')}. Respondé "si" para confirmar.`,
          cart: pendingCart,
          invoice: null,
          logs,
        } satisfies SandboxResponse)
      }

      // Confianza alta, confirmar directamente
      const confirmedCart: CartState = {
        ...existingCart,
        status: 'confirmado',
        pending_confirm: false,
      }
      const invoice = buildInvoicePayload(confirmedCart, phone)
      logs.push({ step: 'confirm_order', data: { items: confirmedCart.items.length, total: confirmedCart.total, invoice_preview: true } })
      return NextResponse.json({
        reply: '✅ Pedido confirmado. Abajo tenés la vista previa del presupuesto que se crearía en FacBal.',
        cart: confirmedCart,
        invoice,
        logs,
      } satisfies SandboxResponse)
    }

    // ─── AGREGAR AL CARRITO / CONSULTAR PRECIO ───
    if (extraction.accion === 'add_to_cart' || extraction.accion === 'price_query') {
      if (!extraction.productos.length) {
        return NextResponse.json({
          reply: 'No entendí qué producto querés. Decímelo con medidas (ej: "bastidor 60x40 sin tela").',
          cart: existingCart,
          invoice: null,
          logs,
        } satisfies SandboxResponse)
      }

      // Armar items para consultar precio a FacBal
      const bulkItems: BulkPriceItem[] = extraction.productos.map((p) => ({
        categoria: p.categoria,
        medida: p.medida,
        variante: p.variante,
        cantidad: p.cantidad || 1,
        regla: p.regla,
      }))

      // Consultar precios a FacBal
      let pricingResult: BulkPriceResult
      try {
        pricingResult = await bulkPrice(bulkItems)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logs.push({ step: 'error', data: { stage: 'bulkPrice', error: msg } })
        return NextResponse.json({
          reply: `Error al consultar precios: ${msg}`,
          cart: existingCart,
          invoice: null,
          logs,
        } satisfies SandboxResponse)
      }

      logs.push({
        step: 'pricing',
        data: {
          items: pricingResult.items.length,
          sugerencias: pricingResult.sugerencias.length,
        },
      })

      // Construir carrito actualizado
      const pricedItems = pricingResult.items.map((d) => ({
        cantidad: d.cantidad,
        categoria: d.categoria,
        medida: d.medida_solicitada,
        variante: d.variante,
        precio: d.precio,
        faltante: d.faltante,
      }))

      const newCart = existingCart?.items?.length
        ? addToCart(existingCart, pricedItems)
        : createCart(pricedItems)

      logs.push({
        step: 'cart_updated',
        data: {
          items: newCart.items.length,
          total: newCart.total,
          faltantes: newCart.items_faltantes,
        },
      })

      // Armar dataContext para que el LLM genere la respuesta
      const dataContext = buildDataContext({
        pricingResult,
        historyText,
        cartText: formatCartForLLM(newCart),
        mensajeProvisional: extraction.mensaje_provisional,
      })

      // Generar respuesta del bot con OpenRouter
      try {
        const result = await callOpenRouter({
          systemPrompt: CHAT_SYSTEM_PROMPT + '\n\n' + dataContext,
          userMessage: text,
        })
        let respuesta = result.text

        logs.push({
          step: 'response',
          data: {
            tokens_in: result.usage.prompt_tokens,
            tokens_out: result.usage.completion_tokens,
          },
        })

        // Reemplazar sentinels
        if (respuesta.includes(HANDOFF_SENTINEL)) {
          logs.push({ step: 'handoff', data: { reason: 'llm-sentinel' } })
          respuesta = 'Te derivo con un agente para ayudarte mejor.'
          return NextResponse.json({
            reply: respuesta,
            cart: newCart,
            invoice: null,
            logs,
          } satisfies SandboxResponse)
        }

        if (respuesta.includes(SHOW_BUDGET_SENTINEL)) {
          const budgetText = formatCartBudget(newCart, `Cliente ${phone}`, phone)
          respuesta = respuesta.replace(SHOW_BUDGET_SENTINEL, '\n\n' + budgetText)
        }

        return NextResponse.json({
          reply: respuesta,
          cart: newCart,
          invoice: null,
          logs,
        } satisfies SandboxResponse)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logs.push({ step: 'error', data: { stage: 'callOpenRouter', error: msg } })
        return NextResponse.json({
          reply: `El bot no pudo generar una respuesta: ${msg}`,
          cart: newCart,
          invoice: null,
          logs,
        } satisfies SandboxResponse)
      }
    }

    // Fallback por si ningún action matcheó
    return NextResponse.json({
      reply: 'No entendí bien tu consulta. Probá siendo más específico.',
      cart: existingCart,
      invoice: null,
      logs,
    } satisfies SandboxResponse)

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json(
      { error: `Error interno: ${msg}`, logs: [] },
      { status: 500 },
    )
  }
}
