import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { engineSendText } from '@/lib/flows/meta-send'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { extractVoucherData } from './voucher-extraction'
import { matchVoucher, type MatchStatus } from './voucher-matching'
import { loadVoucherContext, saveVoucherContext, clearVoucherContext } from './voucher-context'
import {
  matchVoucherByName,
  createVoucherReview,
} from '../facbal/client'
import type { MatchVoucherCandidate, DestinationCandidate } from '../facbal/client'

const MEDIA_TIMEOUT_MS = 15_000

interface PipelineArgs {
  message: {
    id: string
    from: string
    type: string
    text?: string
    image?: { id: string; mime_type: string }
    document?: { id: string; mime_type: string }
  }
  accessToken: string
  accountId: string
  userId: string
  contactId: string
  conversationId: string
}

interface MatchInvoiceInfo {
  invoiceId: number
  numero: string
  clienteNombre: string
  saldoPendiente: number
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

function pickBestMatch(candidates: MatchVoucherCandidate[]): MatchInvoiceInfo | null {
  if (candidates.length === 0) return null
  const best = candidates.reduce((a, b) => (a.score >= b.score ? a : b))
  return {
    invoiceId: best.invoice_id,
    numero: best.numero_factura,
    clienteNombre: best.cliente_nombre,
    saldoPendiente: best.saldo_pendiente,
  }
}

function interpretUserResponse(
  text: string,
  candidates: MatchVoucherCandidate[],
): MatchVoucherCandidate | null {
  const cleaned = text.trim().toLowerCase()

  // Try matching by invoice number
  for (const c of candidates) {
    if (c.numero_factura.toLowerCase().includes(cleaned) || cleaned.includes(c.numero_factura.toLowerCase())) {
      return c
    }
  }

  // Try matching by normalized name tokens
  const nameTokens = (name: string) => name.toLowerCase().split(/\s+/).filter(Boolean)
  const inputTokens = nameTokens(cleaned)
  if (inputTokens.length > 0) {
    for (const c of candidates) {
      const ct = nameTokens(c.cliente_nombre)
      const match = inputTokens.some((t) => ct.some((ctok) => ctok.includes(t) || t.includes(ctok)))
      if (match) return c
    }
  }

  return null
}

export async function processVoucherMessage(args: PipelineArgs): Promise<void> {
  const { message, accessToken, accountId, userId, contactId, conversationId } = args
  const normalizedPhone = message.from
  const sendCtx = { accountId, userId, conversationId, contactId }
  const db = supabaseAdmin()

  console.log('[voucher] START msg_id=%s phone=%s type=%s', message.id, normalizedPhone.slice(-6), message.type)

  // STEP 0 — Load context for multi-turn
  const ctx = await loadVoucherContext(db, conversationId)

  // STEP 0b — If awaiting clarification and this is a text reply
  if (ctx.awaitingConfirmation && ctx.pendingCandidates.length > 0 && (message.type === 'text' || message.text)) {
    const userText = message.text || ''
    console.log('[voucher] User reply to clarification: "%s"', userText)
    const chosen = interpretUserResponse(userText, ctx.pendingCandidates)
    if (chosen) {
      const matched = pickBestMatch([chosen])
      await clearVoucherContext(db, conversationId)

      // Stage the confirmed match
      try {
        const payload = {
          source_message_id: ctx.sourceMessageId || message.id,
          wa_id: normalizedPhone,
          contact_name: null,
          extracted_monto: ctx.pendingExtraction?.monto ?? null,
          extracted_fecha: ctx.pendingExtraction?.fecha ?? null,
          extracted_referencia: ctx.pendingExtraction?.referencia ?? null,
          extracted_banco: ctx.pendingExtraction?.banco ?? null,
          extracted_nombre_cliente: ctx.pendingExtraction?.nombre_cliente ?? null,
          extracted_nombre_origen: ctx.pendingExtraction?.nombre_origen ?? null,
          extracted_nombre_destino: ctx.pendingExtraction?.nombre_destino ?? null,
          match_status: 'matched' as const,
          matched_invoice_id: chosen.invoice_id,
          matched_invoice_numero: chosen.numero_factura,
          matched_cliente_nombre: chosen.cliente_nombre,
          matched_saldo_pendiente: chosen.saldo_pendiente,
          entity_type: null,
          entity_id: null,
          entity_name: null,
          candidatas: ctx.pendingCandidates.map((c) => ({
            invoice_id: c.invoice_id,
            numero_factura: c.numero_factura,
            saldo_pendiente: c.saldo_pendiente,
            cliente_nombre: c.cliente_nombre,
            fecha: c.fecha,
          })),
          media_mime_type: ctx.mediaMimeType || 'application/octet-stream',
          media_base64: ctx.mediaBase64 || '',
        }
        await createVoucherReview(payload)
        console.log('[voucher] Staged for review after user clarification')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[voucher] STAGING after clarification failed:', msg)
      }

      await notify({
        ...sendCtx,
        text: `Gracias. Confirmamos tu pago para ${chosen.cliente_nombre} — Factura ${chosen.numero_factura}. Un agente lo está verificando y pronto lo procesará.`,
      })
    } else {
      const lines = ctx.pendingCandidates.map(
        (c, i) => `${i + 1}. ${c.cliente_nombre} — Factura ${c.numero_factura} — Saldo: $${c.saldo_pendiente.toLocaleString('es-AR')}`,
      )
      await notify({
        ...sendCtx,
        text: 'No entendimos tu respuesta. Por favor respondé con el número de factura o el nombre del cliente exacto.\n\n' + lines.join('\n'),
      })
    }
    return
  }

  // STEP 1 — ACK for new media message
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
  let extractedNombreCliente: string | null = null
  let extractedNombreOrigen: string | null = null
  let extractedNombreDestino: string | null = null
  let matchStatus: MatchStatus = 'no_match'
  let matchedInvoiceId: number | null = null
  let matchedInvoiceNumero: string | null = null
  let matchedClienteNombre: string | null = null
  let matchedSaldoPendiente: number | null = null
  let bestDestination: DestinationCandidate | null = null
  let candidates: MatchVoucherCandidate[] = []
  let destCandidates: DestinationCandidate[] = []
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
    extractedNombreCliente = voucher.nombre_cliente
    extractedNombreOrigen = voucher.nombre_origen
    extractedNombreDestino = voucher.nombre_destino
    console.log(
      '[voucher] Extracted: monto=%s fecha=%s ref=%s banco=%s nombre=%s origen=%s destino=%s',
      voucher.monto, voucher.fecha, voucher.referencia, voucher.banco, voucher.nombre_cliente, voucher.nombre_origen, voucher.nombre_destino,
    )

    // STEP 3 — Extracted, now match by name + amount
    const montoStr = voucher.monto ? `$${voucher.monto.toLocaleString('es-AR')}` : '?'
    const nombreStr = voucher.nombre_cliente || 'desconocido'
    await notify({ ...sendCtx, text: `Comprobante leído: ${nombreStr}, monto ${montoStr}. Buscando coincidencias...` })

    console.log('[voucher] Calling matchVoucherByName nombre=%s monto=%s', nombreStr, montoStr)
    try {
      const result = await matchVoucherByName({
        nombre_cliente: voucher.nombre_cliente,
        nombre_origen: voucher.nombre_origen,
        nombre_destino: voucher.nombre_destino,
        monto: voucher.monto,
        tolerancia: 50,
      })
      candidates = result.invoice_candidates || []
      destCandidates = result.destination_candidates || []
      console.log('[voucher] matchVoucherByName: %d invoice candidates, %d destination candidates', candidates.length, destCandidates.length)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[voucher] MATCH_API failed:', msg)
      errorMessage = `Match API: ${msg}`
    }

    // STEP 4 — Determine match
    const match = matchVoucher({ voucher, candidates, destinationCandidates: destCandidates })
    matchStatus = match.status
    matchedInvoiceId = match.matchedInvoiceId
    bestDestination = match.bestDestination
    mensajeRespuesta = match.mensajeRespuesta
    console.log('[voucher] Match result: status=%s bestDest=%s', match.status, bestDestination?.entity_name || 'none')

    const matchedInfo = pickBestMatch(match.candidatas)
    if (matchedInfo) {
      matchedInvoiceId = matchedInfo.invoiceId
      matchedInvoiceNumero = matchedInfo.numero
      matchedClienteNombre = matchedInfo.clienteNombre
      matchedSaldoPendiente = matchedInfo.saldoPendiente
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[voucher] EXTRACTION failed:', msg)
    errorMessage = `Extraction: ${msg}`
    matchStatus = 'no_match'
    mensajeRespuesta =
      'Gracias por tu comprobante. No pudimos leerlo automáticamente. Un agente lo revisará y te confirmará el pago.'
  }

  // STEP 5 — Stage to backend_gal for ALL statuses (matched, ambiguous, no_match)
  // so they appear in the FacGal review panel. Only ambiguous also saves context
  // for multi-turn follow-up.
  async function stageVoucher(stageStatus: MatchStatus): Promise<void> {
    try {
      const payload = {
        source_message_id: message.id,
        wa_id: normalizedPhone,
        contact_name: null,
        extracted_monto: extractedAmount,
        extracted_fecha: extractedDate,
        extracted_referencia: extractedReference,
        extracted_banco: extractedBank,
        extracted_nombre_cliente: extractedNombreCliente,
        extracted_nombre_origen: extractedNombreOrigen,
        extracted_nombre_destino: extractedNombreDestino,
        match_status: stageStatus,
        matched_invoice_id: matchedInvoiceId,
        matched_invoice_numero: matchedInvoiceNumero,
        matched_cliente_nombre: matchedClienteNombre,
        matched_saldo_pendiente: matchedSaldoPendiente,
        entity_type: bestDestination?.entity_type ?? null,
        entity_id: bestDestination?.entity_id ?? null,
        entity_name: bestDestination?.entity_name ?? null,
        candidatas: candidates.map((c) => ({
          invoice_id: c.invoice_id,
          numero_factura: c.numero_factura,
          saldo_pendiente: c.saldo_pendiente,
          cliente_nombre: c.cliente_nombre,
          fecha: c.fecha,
        })),
        media_mime_type: mimeType,
        media_base64: mediaBase64,
      }
      await createVoucherReview(payload)
      console.log('[voucher] Staged for manual review (status=%s)', stageStatus)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[voucher] STAGING failed:', msg)
      errorMessage = [errorMessage, `Staging: ${msg}`].filter(Boolean).join(' | ')
    }
  }

  await stageVoucher(matchStatus)

  if (matchStatus === 'ambiguous') {
    // Save context for follow-up multi-turn
    await saveVoucherContext(db, conversationId, {
      pendingExtraction: {
        monto: extractedAmount,
        fecha: extractedDate,
        referencia: extractedReference,
        banco: extractedBank,
        nombre_cliente: extractedNombreCliente,
        nombre_origen: extractedNombreOrigen,
        nombre_destino: extractedNombreDestino,
      },
      pendingCandidates: candidates,
      awaitingConfirmation: true,
      mediaBase64,
      mediaMimeType: mimeType,
      sourceMessageId: message.id,
    })
    console.log('[voucher] Saved context, awaiting user clarification')
  } else if (matchStatus !== 'no_match') {
    // matched: clear context if any
    await clearVoucherContext(db, conversationId)
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

  // STEP 6 — Final response
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
