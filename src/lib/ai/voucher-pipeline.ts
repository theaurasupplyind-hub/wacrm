import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { engineSendText } from '@/lib/flows/meta-send'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { extractVoucherData } from './voucher-extraction'
import { matchVoucher, type MatchStatus, findClientMatches, montoDistance } from './voucher-matching'
import { loadVoucherContext, addPendingVoucher, removePendingVoucher, clearVoucherContext, consumePendingText } from './voucher-context'
import {
  matchVoucherByName,
  createVoucherReview,
  registrarPago,
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

function formatMonto(n: number): string {
  return `$${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
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

function interpretMultiInvoiceResponse(
  text: string,
  candidates: MatchVoucherCandidate[],
): MatchVoucherCandidate[] {
  const cleaned = text.trim().toLowerCase()

  // "si", "sí", "confirmar", "ok" → all candidates
  if (/^(si|sí|confirmo?|ok|dale|adelante|todos|todas)$/i.test(cleaned)) {
    return [...candidates]
  }

  // "todas", "si", "confirmar" → all candidates
  if (/^(tod[ao]s?|s[ií]|confirmo?|ok|dale|adelante)$/i.test(cleaned)) {
    return [...candidates]
  }

  // Try parsing numbers separated by commas, spaces, "y", "e"
  const numbers = cleaned.match(/\d+/g)
  if (numbers) {
    const indices = numbers.map(Number).filter((n) => n >= 1 && n <= candidates.length)
    if (indices.length > 0) {
      return indices.map((i) => candidates[i - 1])
    }
  }

  // Try matching by invoice numbers
  const matched: MatchVoucherCandidate[] = []
  for (const c of candidates) {
    if (c.numero_factura.toLowerCase().includes(cleaned) || cleaned.includes(c.numero_factura.toLowerCase())) {
      matched.push(c)
    }
  }
  if (matched.length > 0) return matched

  return []
}

export async function processVoucherMessage(args: PipelineArgs): Promise<void> {
  const { message, accessToken, accountId, userId, contactId, conversationId } = args
  const normalizedPhone = message.from
  const sendCtx = { accountId, userId, conversationId, contactId }
  const db = supabaseAdmin()

  console.log('[voucher] START msg_id=%s phone=%s type=%s', message.id, normalizedPhone.slice(-6), message.type)

  // STEP 0 — Idempotencia: skip if this message was already processed
  if (message.type !== 'text' && message.id) {
    try {
      const { data: existing } = await db
        .from('voucher_extractions')
        .select('message_id')
        .eq('message_id', message.id)
        .maybeSingle()
      if (existing) {
        console.log('[voucher] SKIP duplicate msg_id=%s', message.id)
        return
      }
    } catch {
      // table might not exist, continue anyway
    }
  }

  // STEP 0b — Load context for multi-turn
  const ctx = await loadVoucherContext(db, conversationId)

  // STEP 0b — If there are pending items awaiting clarification and this is a text reply
  const pendingItem = ctx.pending.length > 0 ? ctx.pending[0] : null
  if (pendingItem && (message.type === 'text' || message.text)) {
    const userText = message.text || ''
    console.log('[voucher] User reply to clarification: "%s" (pending msg=%s multiInvoice=%s)', userText, pendingItem.sourceMessageId, pendingItem.multiInvoice)

    if (pendingItem.multiInvoice) {
      const selected = interpretMultiInvoiceResponse(userText, pendingItem.candidates)
      if (selected.length > 0) {
        await removePendingVoucher(db, conversationId, pendingItem.sourceMessageId)
        const fechaPago = pendingItem.extraction.fecha || new Date().toISOString().slice(0, 10)
        const paidList: string[] = []
        let errors: string[] = []
        let remaining = pendingItem.extraction.monto ?? 0

        for (const inv of selected) {
          const pago = Math.min(remaining, inv.saldo_pendiente)
          if (pago <= 0) continue

          try {
            await registrarPago({
              invoiceId: inv.invoice_id,
              monto: pago,
              fecha: fechaPago,
              entityType: pendingItem.bestDestination?.entity_type ?? null,
              entityId: pendingItem.bestDestination?.entity_id ?? null,
            })
            paidList.push(`${inv.cliente_nombre} — Factura ${inv.numero_factura}: ${formatMonto(pago)}`)
            remaining -= pago
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            errors.push(`${inv.numero_factura}: ${msg}`)
          }
        }

        if (paidList.length > 0) {
          let reply = `Se registraron los pagos:\n${paidList.join('\n')}`
          if (remaining > 0) {
            reply += `\n\nQuedó un saldo de ${formatMonto(remaining)} sin asignar. Un agente lo revisará.`
          }
          if (errors.length > 0) {
            reply += `\n\nErrores al registrar:\n${errors.join('\n')}`
          }
          await notify({ ...sendCtx, text: reply })
        } else {
          await notify({ ...sendCtx, text: 'No se pudo registrar ningún pago. Un agente lo revisará.' })
        }
      } else {
        const lines = pendingItem.candidates.map(
          (c, i) => `${i + 1}. ${c.cliente_nombre} — Factura ${c.numero_factura} — Saldo: $${c.saldo_pendiente.toLocaleString('es-AR')}`,
        )
        await notify({
          ...sendCtx,
          text: 'No entendimos tu respuesta. Respondé con los números separados por coma (ej: 1,2) o decí "todas".\n\n' + lines.join('\n'),
        })
      }
      return
    }
    const chosen = interpretUserResponse(userText, pendingItem.candidates)
    if (chosen) {
      await removePendingVoucher(db, conversationId, pendingItem.sourceMessageId)

      // Stage the confirmed match
      try {
        const payload = {
          source_message_id: pendingItem.sourceMessageId,
          wa_id: normalizedPhone,
          contact_name: null,
          extracted_monto: pendingItem.extraction.monto ?? null,
          extracted_fecha: pendingItem.extraction.fecha ?? null,
          extracted_referencia: pendingItem.extraction.referencia ?? null,
          extracted_banco: pendingItem.extraction.banco ?? null,
          extracted_nombre_cliente: pendingItem.extraction.nombre_cliente ?? null,
          extracted_nombre_origen: pendingItem.extraction.nombre_origen ?? null,
          extracted_nombre_destino: pendingItem.extraction.nombre_destino ?? null,
          extracted_cbu_destino: pendingItem.extraction.cbu_destino ?? null,
          extracted_cuit_destino: pendingItem.extraction.cuit_destino ?? null,
          match_status: 'matched' as const,
          matched_invoice_id: chosen.invoice_id,
          matched_invoice_numero: chosen.numero_factura,
          matched_cliente_nombre: chosen.cliente_nombre,
          matched_saldo_pendiente: chosen.saldo_pendiente,
          entity_type: null,
          entity_id: null,
          entity_name: null,
          candidatas: pendingItem.candidates.map((c) => ({
            invoice_id: c.invoice_id,
            numero_factura: c.numero_factura,
            saldo_pendiente: c.saldo_pendiente,
            cliente_nombre: c.cliente_nombre,
            fecha: c.fecha,
          })),
          media_mime_type: pendingItem.mediaMimeType,
          media_base64: pendingItem.mediaBase64,
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
      const lines = pendingItem.candidates.map(
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
  await notify({ ...sendCtx, text: 'Comprobante recibido, revisando, tomara un segundo...' })

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
  let extractedAmount: number | null = null
  let extractedDate: string | null = null
  let extractedReference: string | null = null
  let extractedBank: string | null = null
  let extractedNombreCliente: string | null = null
  let extractedNombreOrigen: string | null = null
  let extractedNombreDestino: string | null = null
  let extractedCbuDestino: string | null = null
  let extractedCuitDestino: string | null = null
  let matchStatus: MatchStatus = 'no_match'
  let matchedInvoiceId: number | null = null
  let matchedInvoiceNumero: string | null = null
  let matchedClienteNombre: string | null = null
  let matchedSaldoPendiente: number | null = null
  let bestDestination: DestinationCandidate | null = null
  let candidates: MatchVoucherCandidate[] = []
  let destCandidates: DestinationCandidate[] = []
  let mensajeRespuesta = 'Error inesperado al procesar el comprobante.'
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
    extractedCbuDestino = voucher.cbu_destino
    extractedCuitDestino = voucher.cuit_destino
    console.log(
      '[voucher] Extracted: monto=%s fecha=%s ref=%s banco=%s nombre=%s origen=%s destino=%s cbu=%s cuit=%s',
      voucher.monto, voucher.fecha, voucher.referencia, voucher.banco, voucher.nombre_cliente, voucher.nombre_origen, voucher.nombre_destino, voucher.cbu_destino, voucher.cuit_destino,
    )

    // STEP 3 — Extracted, now match
    // ── Phase 1: Amount-only (highest priority) ──
    //     If exact amount matches 1 invoice → matched.
    //     If client total balance matches → multi_invoice.
    //     If no match → Phase 2.
    if (voucher.monto && voucher.monto > 0) {
      console.log('[voucher-debug] === Phase 1: Amount-only search ===')
      console.log('[voucher-debug]   monto=%s, tolerancia=%s', voucher.monto, Math.max(10_000, voucher.monto))
      try {
        const amountResult = await matchVoucherByName({
          nombre_cliente: null,
          nombre_origen: null,
          nombre_destino: null,
          cbu_destino: null,
          cuit_destino: null,
          monto: voucher.monto,
          tolerancia: Math.max(10_000, voucher.monto),
        })
        const amountCandidates = amountResult.invoice_candidates || []
        console.log('[voucher-debug] Phase 1 API: %d candidates', amountCandidates.length)
        if (amountCandidates.length > 0) {
          console.table(amountCandidates.map(c => ({
            factura: c.numero_factura,
            cliente: c.cliente_nombre,
            saldo: c.saldo_pendiente,
            score: c.score,
          })))
        }

        if (amountCandidates.length > 0) {
          const amountMatch = matchVoucher({
            voucher,
            candidates: amountCandidates,
            destinationCandidates: [],
          })

          if (amountMatch.status === 'matched') {
            matchStatus = 'matched'
            matchedInvoiceId = amountMatch.matchedInvoiceId
            bestDestination = amountMatch.bestDestination
            mensajeRespuesta = amountMatch.mensajeRespuesta
            candidates = amountMatch.candidatas
            console.log('[voucher-debug] Phase 1 result: matched (invoice_id=%s)', amountMatch.matchedInvoiceId)
          } else if (amountMatch.status === 'multi_invoice') {
            matchStatus = 'multi_invoice'
            mensajeRespuesta = amountMatch.mensajeRespuesta
            candidates = amountMatch.candidatas
            console.log('[voucher-debug] Phase 1 result: multi_invoice')
            console.log('[voucher-debug] msg: %s', amountMatch.mensajeRespuesta)
          } else if (amountMatch.status === 'ambiguous') {
            matchStatus = 'ambiguous'
            mensajeRespuesta = amountMatch.mensajeRespuesta
            candidates = amountMatch.candidatas
            console.log('[voucher-debug] Phase 1 result: ambiguous')
          } else {
            console.log('[voucher-debug] Phase 1 result: no_match → trying client groups')
            const clientMatches = findClientMatches(voucher.monto, amountCandidates)
            if (clientMatches.length > 0) {
              const bestClient = clientMatches[0]
              matchStatus = 'multi_invoice'
              candidates = bestClient.invoices
              console.log('[voucher-debug] Phase 1 client match: %s (suma=%s, dif=%s)',
                bestClient.clientName, bestClient.total, montoDistance(voucher.monto, bestClient.total))
              console.table(bestClient.invoices.map(c => ({
                factura: c.numero_factura,
                saldo: c.saldo_pendiente,
              })))
              mensajeRespuesta = `Tu pago de ${formatMonto(voucher.monto)} coincide con el saldo total de ${bestClient.clientName}. ¿Confirmás que querés pagar estas facturas?\n\n` +
                bestClient.invoices.map((c, i) => `${i + 1}. ${c.cliente_nombre} — Factura ${c.numero_factura} — Saldo: ${formatMonto(c.saldo_pendiente)}`).join('\n') +
                '\n\nRespondé "sí", "confirmar" o los números separados por coma.'
              console.log('[voucher] Phase 1: client match found: %s', bestClient.clientName)
            } else {
              console.log('[voucher-debug] Phase 1: no client groups matched')
              // Store candidates for Phase 3 fallback
              ;(globalThis as Record<string, unknown>)._voucherAmountCandidates = amountCandidates
            }
          }
        } else {
          console.log('[voucher-debug] Phase 1: API returned 0 candidates')
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[voucher-debug] Phase 1 search FAILED:', msg)
        console.error('[voucher] Phase 1 search failed:', msg)
        errorMessage = [errorMessage, `Phase1: ${msg}`].filter(Boolean).join(' | ')
      }
    }

    // ── Phase 2: Name-based (second priority) ──
    if ((matchStatus === 'no_match' || matchStatus === 'ambiguous') && (voucher.nombre_cliente || voucher.nombre_origen)) {
      console.log('[voucher-debug] === Phase 2: Name-based search ===')
      console.log('[voucher-debug]   nombre_cliente="%s" nombre_origen="%s" monto=%s tolerancia=50',
        voucher.nombre_cliente, voucher.nombre_origen, voucher.monto)
      try {
        const nameResult = await matchVoucherByName({
          nombre_cliente: voucher.nombre_cliente,
          nombre_origen: voucher.nombre_origen,
          nombre_destino: voucher.nombre_destino,
          cbu_destino: voucher.cbu_destino,
          cuit_destino: voucher.cuit_destino,
          monto: voucher.monto,
          tolerancia: 50,
        })
        const nameCandidates = nameResult.invoice_candidates || []
        const nameDestCandidates = nameResult.destination_candidates || []
        console.log('[voucher-debug] Phase 2 API: %d candidates', nameCandidates.length)
        if (nameCandidates.length > 0) {
          console.table(nameCandidates.map(c => ({
            factura: c.numero_factura,
            cliente: c.cliente_nombre,
            saldo: c.saldo_pendiente,
            score: c.score,
          })))
        }

        if (nameCandidates.length > 0) {
          const nameMatch = matchVoucher({
            voucher,
            candidates: nameCandidates,
            destinationCandidates: nameDestCandidates,
          })

          if (nameMatch.status !== 'no_match') {
            matchStatus = nameMatch.status
            matchedInvoiceId = nameMatch.matchedInvoiceId
            bestDestination = nameMatch.bestDestination || bestDestination
            mensajeRespuesta = nameMatch.mensajeRespuesta
            candidates = nameMatch.candidatas
            console.log('[voucher-debug] Phase 2 result: %s (invoice_id=%s)', nameMatch.status, nameMatch.matchedInvoiceId)
          } else if (voucher.monto && voucher.monto > 0) {
            console.log('[voucher-debug] Phase 2: no_match → trying client groups')
            const clientMatches = findClientMatches(voucher.monto, nameCandidates)
            if (clientMatches.length > 0) {
              const bestClient = clientMatches[0]
              matchStatus = 'multi_invoice'
              candidates = bestClient.invoices
              console.log('[voucher-debug] Phase 2 client match: %s (suma=%s, dif=%s)',
                bestClient.clientName, bestClient.total, montoDistance(voucher.monto, bestClient.total))
              console.table(bestClient.invoices.map(c => ({
                factura: c.numero_factura,
                saldo: c.saldo_pendiente,
              })))
              mensajeRespuesta = `Tu pago de ${formatMonto(voucher.monto)} coincide con el saldo total de ${bestClient.clientName}. ¿Confirmás que querés pagar estas facturas?\n\n` +
                bestClient.invoices.map((c, i) => `${i + 1}. ${c.cliente_nombre} — Factura ${c.numero_factura} — Saldo: ${formatMonto(c.saldo_pendiente)}`).join('\n') +
                '\n\nRespondé "sí", "confirmar" o los números separados por coma.'
              console.log('[voucher] Phase 2: client match found: %s', bestClient.clientName)
            } else {
              console.log('[voucher-debug] Phase 2: no client groups matched')
            }
          }
        } else {
          console.log('[voucher-debug] Phase 2: API returned 0 candidates')
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[voucher-debug] Phase 2 search FAILED:', msg)
        console.error('[voucher] Phase 2 search failed:', msg)
        errorMessage = [errorMessage, `Phase2: ${msg}`].filter(Boolean).join(' | ')
      }
    }

    // ── Phase 3: Ask user (last resort) ──
    if (matchStatus === 'no_match') {
      console.log('[voucher-debug] === Phase 3: Ask user ===')
      const amountCands = ((globalThis as Record<string, unknown>)._voucherAmountCandidates || []) as MatchVoucherCandidate[]
      delete (globalThis as Record<string, unknown>)._voucherAmountCandidates

      if (amountCands.length > 0) {
        candidates = amountCands
        matchStatus = 'ambiguous'
        console.log('[voucher-debug] Phase 3: showing %d candidates to user', amountCands.length)
        console.table(amountCands.map(c => ({
          factura: c.numero_factura,
          cliente: c.cliente_nombre,
          saldo: c.saldo_pendiente,
        })))
        mensajeRespuesta = 'No pudimos identificar a qué factura corresponde tu pago. ¿Cuál de estas facturas querés pagar?\n\n' +
          amountCands.map((c, i) => `${i + 1}. ${c.cliente_nombre} — Factura ${c.numero_factura} — Saldo: ${formatMonto(c.saldo_pendiente)}`).join('\n') +
          '\n\nRespondé con el número de factura o el nombre del cliente.'
        console.log('[voucher] Phase 3: showing %d candidates to user', amountCands.length)
      } else {
        console.log('[voucher-debug] Phase 3: no stored candidates')
      }
    }

    console.log('[voucher-debug] === FINAL RESULT ===')
    console.log('[voucher-debug]   matchStatus=%s', matchStatus)
    console.log('[voucher-debug]   matchedInvoiceId=%s', matchedInvoiceId)
    console.log('[voucher-debug]   matchedInvoiceNumero=%s', matchedInvoiceNumero)
    console.log('[voucher-debug]   matchedClienteNombre=%s', matchedClienteNombre)
    console.log('[voucher-debug]   matchedSaldoPendiente=%s', matchedSaldoPendiente)
    console.log('[voucher-debug]   errorMessage=%s', errorMessage)
    console.log('[voucher-debug]   mensajeRespuesta: %s', mensajeRespuesta)

    const matchedInfo = pickBestMatch(candidates)
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
  async function stageVoucher(stageStatus: 'matched' | 'ambiguous' | 'no_match', reviewStatus?: string): Promise<void> {
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
        extracted_cbu_destino: extractedCbuDestino,
        extracted_cuit_destino: extractedCuitDestino,
        match_status: stageStatus,
        review_status: reviewStatus,
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

  // Stage to backend_gal first
  if (matchStatus === 'matched') {
    await stageVoucher('matched', 'completed')
  } else {
    const stageStatus: 'matched' | 'ambiguous' | 'no_match' =
      matchStatus === 'multi_invoice' ? 'ambiguous' : matchStatus
    await stageVoucher(stageStatus)
  }

  // If matched, register the actual payment
  if (matchStatus === 'matched' && matchedInvoiceId !== null && extractedAmount !== null && extractedAmount > 0) {
    try {
      const fechaPago = extractedDate || new Date().toISOString().slice(0, 10)
      await registrarPago({
        invoiceId: matchedInvoiceId,
        monto: extractedAmount,
        fecha: fechaPago,
        entityType: bestDestination?.entity_type ?? null,
        entityId: bestDestination?.entity_id ?? null,
      })
      console.log('[voucher] Payment registered OK invoice=%s amount=%s', matchedInvoiceId, extractedAmount)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[voucher] PAYMENT_FAILED:', msg)
      errorMessage = [errorMessage, `Payment: ${msg}`].filter(Boolean).join(' | ')
      // The review is staged as 'completed' but payment failed — let user know
      mensajeRespuesta = 'Registramos el comprobante pero hubo un error al crear el pago. Un agente lo revisará.'
    }
  }

  if (matchStatus === 'multi_invoice') {
    await addPendingVoucher(db, conversationId, {
      sourceMessageId: message.id,
      extraction: {
        monto: extractedAmount,
        fecha: extractedDate,
        referencia: extractedReference,
        banco: extractedBank,
        nombre_cliente: extractedNombreCliente,
        nombre_origen: extractedNombreOrigen,
        nombre_destino: extractedNombreDestino,
        cbu_destino: extractedCbuDestino,
        cuit_destino: extractedCuitDestino,
      },
      candidates,
      bestDestination,
      mediaBase64,
      mediaMimeType: mimeType,
      multiInvoice: true,
    })
    console.log('[voucher] multi_invoice: pushed to pending array, awaiting user selection')

    try {
      const pendingText = await consumePendingText(db, conversationId)
      if (pendingText) {
        console.log('[voucher] multi_invoice: auto-consuming pending text: "%s"', pendingText)
        const autoSelected = interpretMultiInvoiceResponse(pendingText, candidates)
        if (autoSelected.length > 0) {
          await removePendingVoucher(db, conversationId, message.id)
          const fechaPago = extractedDate || new Date().toISOString().slice(0, 10)
          let remaining = extractedAmount ?? 0
          const paidList: string[] = []

          for (const inv of autoSelected) {
            const pago = Math.min(remaining, inv.saldo_pendiente)
            if (pago <= 0) continue
            try {
              await registrarPago({
                invoiceId: inv.invoice_id,
                monto: pago,
                fecha: fechaPago,
                entityType: bestDestination?.entity_type ?? null,
                entityId: bestDestination?.entity_id ?? null,
              })
              paidList.push(`${inv.cliente_nombre} — Factura ${inv.numero_factura}: $${pago.toLocaleString('es-AR')}`)
              remaining -= pago
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              console.error('[voucher] multi_invoice auto payment failed:', msg)
            }
          }

          if (paidList.length > 0) {
            let reply = `Se registraron los pagos:\n${paidList.join('\n')}`
            if (remaining > 0) {
              reply += `\n\nQuedó un saldo de $${remaining.toLocaleString('es-AR')} sin asignar. Un agente lo revisará.`
            }
            mensajeRespuesta = reply
            matchStatus = 'matched'
          }
        }
      }
    } catch (err) {
      console.error('[voucher] multi_invoice auto-consume error:', err)
    }
  }

  if (matchStatus === 'ambiguous') {
    // Push to pending array for follow-up multi-turn
    await addPendingVoucher(db, conversationId, {
      sourceMessageId: message.id,
      extraction: {
        monto: extractedAmount,
        fecha: extractedDate,
        referencia: extractedReference,
        banco: extractedBank,
        nombre_cliente: extractedNombreCliente,
        nombre_origen: extractedNombreOrigen,
        nombre_destino: extractedNombreDestino,
        cbu_destino: extractedCbuDestino,
        cuit_destino: extractedCuitDestino,
      },
      candidates,
      bestDestination,
      mediaBase64,
      mediaMimeType: mimeType,
    })
    console.log('[voucher] Pushed to pending array, awaiting user clarification')

    // Auto-consume any pending text that was stored before the context
    try {
      const pendingText = await consumePendingText(db, conversationId)
      if (pendingText) {
        console.log('[voucher] Auto-consuming pending text: "%s"', pendingText)
        const autoChosen = interpretUserResponse(pendingText, candidates)
        if (autoChosen) {
          await removePendingVoucher(db, conversationId, message.id)
          // Stage confirmed match (same logic as user confirmation block)
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
            extracted_cbu_destino: extractedCbuDestino,
            extracted_cuit_destino: extractedCuitDestino,
            match_status: 'matched' as const,
            matched_invoice_id: autoChosen.invoice_id,
            matched_invoice_numero: autoChosen.numero_factura,
            matched_cliente_nombre: autoChosen.cliente_nombre,
            matched_saldo_pendiente: autoChosen.saldo_pendiente,
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
          console.log('[voucher] Auto-resolved by pending text')
          mensajeRespuesta = `Gracias. Tu pago para ${autoChosen.cliente_nombre} — Factura ${autoChosen.numero_factura} se está procesando.`
          matchStatus = 'matched'
        } else {
          // Pending text didn't match, keep ambiguous state
          console.log('[voucher] Pending text did not match any candidate')
        }
      }
    } catch (err) {
      console.error('[voucher] Auto-consume pending text error:', err)
    }
  } else if (matchStatus === 'matched') {
    // Remove from pending stack if it was there (e.g. re-processed via context)
    await removePendingVoucher(db, conversationId, message.id)
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
