import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { engineSendText } from '@/lib/flows/meta-send'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { extractVoucherData } from './voucher-extraction'
import { matchVoucher, type MatchStatus } from './voucher-matching'
import {
  getFacturasPendientes,
  registrarPago,
} from '../facbal/client'
import type { FacturaPendiente } from '../facbal/client'

const MEDIA_TIMEOUT_MS = 15_000

interface PipelineArgs {
  message: {
    id: string
    from: string
    type: string
    image?: { id: string; mime_type: string }
    document?: { id: string; mime_type: string }
  }
  accessToken: string
  accountId: string
  userId: string
  contactId: string
  conversationId: string
}

function mediaTimeout(): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Media download timed out after 15s')), MEDIA_TIMEOUT_MS),
  )
}

async function notify(args: {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  text: string
}): Promise<void> {
  try {
    await engineSendText(args)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[voucher] notify failed:', msg)
  }
}

export async function processVoucherMessage(args: PipelineArgs): Promise<void> {
  const { message, accessToken, accountId, userId, contactId, conversationId } = args
  const normalizedPhone = message.from
  const sendCtx = { accountId, userId, conversationId, contactId }

  console.log('[voucher] START msg_id=%s phone=%s type=%s', message.id, normalizedPhone.slice(-6), message.type)

  // STEP 1 — ACK
  await notify({ ...sendCtx, text: 'Recibimos tu comprobante. Lo estamos procesando...' })

  let mediaBase64: string
  let mimeType: string

  try {
    const mediaId =
      message.image?.id ??
      message.document?.id ??
      null

    mimeType =
      message.image?.mime_type ??
      message.document?.mime_type ??
      'application/octet-stream'

    if (!mediaId) {
      console.error('[voucher] NO_MEDIA_ID')
      await saveAttempt({
        messageId: message.id,
        contactId,
        matchStatus: 'no_match',
        errorMessage: 'No media ID in message',
      })
      return
    }

    console.log('[voucher] Downloading media id=%s mime=%s', mediaId, mimeType)
    const { url: downloadUrl } = await Promise.race([
      getMediaUrl({ mediaId, accessToken }),
      mediaTimeout(),
    ])
    const { buffer } = await Promise.race([
      downloadMedia({ downloadUrl, accessToken }),
      mediaTimeout(),
    ])
    mediaBase64 = Buffer.from(buffer).toString('base64')
    console.log('[voucher] Media downloaded size=%d bytes', buffer.length)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[voucher] MEDIA_DOWNLOAD failed:', msg)
    await saveAttempt({
      messageId: message.id,
      contactId,
      matchStatus: 'no_match',
      errorMessage: `Media download: ${msg}`,
    })
    await notify({ ...sendCtx, text: 'No pudimos descargar la imagen. Un agente lo revisará.' })
    return
  }

  // STEP 2 — Downloaded, now analyzing
  await notify({ ...sendCtx, text: 'Analizando el comprobante con IA...' })

  let extractedAmount: number | null = null
  let extractedDate: string | null = null
  let extractedReference: string | null = null
  let extractedBank: string | null = null
  let matchStatus: MatchStatus = 'no_match'
  let matchedInvoiceId: number | null = null
  let mensajeRespuesta: string
  let errorMessage: string | null = null

  try {
    console.log('[voucher] Calling OpenRouter model=%s', process.env.VOUCHER_AI_MODEL || 'google/gemini-2.5-flash')
    const voucher = await extractVoucherData({
      base64: mediaBase64,
      mimeType,
    })

    extractedAmount = voucher.monto
    extractedDate = voucher.fecha
    extractedReference = voucher.referencia
    extractedBank = voucher.banco
    console.log('[voucher] Extracted: monto=%s fecha=%s ref=%s banco=%s', voucher.monto, voucher.fecha, voucher.referencia, voucher.banco)

    // STEP 3 — Extracted, now searching invoices
    const montoStr = voucher.monto ? `$${voucher.monto.toLocaleString('es-AR')}` : '?'
    await notify({ ...sendCtx, text: `Comprobante leído: monto ${montoStr}. Buscando tus facturas pendientes...` })

    console.log('[voucher] Querying FacBal for phone=%s', normalizedPhone.slice(-6))
    let facturasPendientes: FacturaPendiente[]
    try {
      facturasPendientes = await getFacturasPendientes(normalizedPhone)
      console.log('[voucher] FacBal returned %d pending invoices', facturasPendientes.length)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[voucher] FACBAL_API failed:', msg)
      await saveAttempt({
        messageId: message.id,
        contactId,
        matchStatus: 'no_match',
        extractedAmount,
        extractedDate,
        extractedReference,
        extractedBank,
        errorMessage: `FacBal API: ${msg}`,
      })
      await notify({ ...sendCtx, text: 'Error al consultar tus facturas. Un agente te contactará.' })
      return
    }

    // STEP 4 — Invoices found
    if (facturasPendientes.length === 0) {
      await notify({ ...sendCtx, text: 'No encontramos facturas pendientes a tu nombre.' })
    } else {
      await notify({ ...sendCtx, text: `Encontramos ${facturasPendientes.length} factura(s) pendiente(s). Verificando...` })
    }

    const match = matchVoucher({ voucher, facturasPendientes })
    matchStatus = match.status
    matchedInvoiceId = match.matchedInvoiceId
    mensajeRespuesta = match.mensajeRespuesta
    console.log('[voucher] Match result: status=%s invoiceId=%s', match.status, match.matchedInvoiceId)

    if (match.status === 'matched' && matchedInvoiceId !== null && voucher.monto !== null) {
      try {
        const fechaPago = voucher.fecha || new Date().toLocaleDateString('es-AR')
        console.log('[voucher] Registering payment invoice=%d amount=%s', matchedInvoiceId, voucher.monto)
        await registrarPago({
          invoiceId: matchedInvoiceId,
          monto: voucher.monto,
          fecha: fechaPago,
        })
        console.log('[voucher] Payment registered OK')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[voucher] FACBAL_PAYMENT failed:', msg)
        errorMessage = `Pago registrado en FacBal falló: ${msg}`
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[voucher] EXTRACTION failed:', msg)
    errorMessage = `Extraction: ${msg}`
    matchStatus = 'no_match'
    mensajeRespuesta =
      'Gracias por tu comprobante. No pudimos leerlo automáticamente. Un agente lo revisará y te confirmará el pago.'
  }

  await saveAttempt({
    messageId: message.id,
    contactId,
    extractedAmount,
    extractedDate,
    extractedReference,
    extractedBank,
    matchStatus,
    matchedInvoiceId,
    errorMessage,
  })

  // STEP 5 — Final response
  try {
    console.log('[voucher] Sending reply to WhatsApp')
    await engineSendText({ ...sendCtx, text: mensajeRespuesta! })
    console.log('[voucher] Reply sent OK')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[voucher] WHATSAPP_REPLY failed:', msg)
  }

  console.log('[voucher] END status=%s', matchStatus)
}

async function saveAttempt(args: {
  messageId: string
  contactId: string
  matchStatus: MatchStatus
  extractedAmount?: number | null
  extractedDate?: string | null
  extractedReference?: string | null
  extractedBank?: string | null
  matchedInvoiceId?: number | null
  errorMessage?: string | null
}): Promise<void> {
  try {
    console.log('[voucher] Saving attempt: status=%s error=%s', args.matchStatus, args.errorMessage || 'none')
    await supabaseAdmin().from('voucher_extractions').insert({
      message_id: args.messageId,
      contact_id: args.contactId,
      extracted_amount: args.extractedAmount ?? null,
      extracted_date: args.extractedDate ?? null,
      extracted_reference: args.extractedReference ?? null,
      extracted_bank: args.extractedBank ?? null,
      match_status: args.matchStatus,
      matched_invoice_id: args.matchedInvoiceId ?? null,
      error_message: args.errorMessage ?? null,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('relation') && msg.includes('does not exist')) {
      console.error('[voucher] TABLE MISSING — run migration 031_voucher_extractions.sql in Supabase')
    } else {
      console.error('[voucher] Failed to save extraction record:', msg)
    }
  }
}
