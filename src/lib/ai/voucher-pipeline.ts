import { getMediaUrl, downloadMedia, sendTextMessage } from '@/lib/whatsapp/meta-api'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { extractVoucherData } from './voucher-extraction'
import { matchVoucher, type MatchStatus } from './voucher-matching'
import {
  getFacturasPendientes,
  registrarPago,
} from '../facbal/client'
import type { FacturaPendiente } from '../facbal/client'

interface PipelineArgs {
  message: {
    id: string
    from: string
    type: string
    image?: { id: string; mime_type: string }
    document?: { id: string; mime_type: string }
  }
  accessToken: string
  phoneNumberId: string
  contactId: string
}

/**
 * Full voucher processing pipeline. Download media from Meta,
 * extract data via OpenRouter, match against FacBal pending
 * invoices, register payment or ask for clarification, and
 * persist the result to Supabase.
 *
 * Called fire-and-forget from the webhook handler — never awaited
 * so it does not block the 200 response to Meta.
 */
export async function processVoucherMessage(args: PipelineArgs): Promise<void> {
  const { message, accessToken, phoneNumberId, contactId } = args
  const normalizedPhone = message.from

  console.log('[voucher] START msg_id=%s phone=%s type=%s', message.id, normalizedPhone.slice(-6), message.type)

  // Send instant acknowledgment so the customer knows we received it
  try {
    await sendTextMessage({
      phoneNumberId,
      accessToken,
      to: normalizedPhone,
      text: 'Gracias por tu comprobante, lo estoy procesando. En un momento te confirmo.',
    })
    console.log('[voucher] ACK sent')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[voucher] ACK failed:', msg)
  }

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
    const { url: downloadUrl } = await getMediaUrl({ mediaId, accessToken })
    const { buffer } = await downloadMedia({ downloadUrl, accessToken })
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
    return
  }

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
      return
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

  try {
    console.log('[voucher] Sending reply to WhatsApp')
    await sendTextMessage({
      phoneNumberId,
      accessToken,
      to: normalizedPhone,
      text: mensajeRespuesta!,
    })
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
