import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { engineSendText } from '@/lib/flows/meta-send'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { extractVoucherData } from './voucher-extraction'
import { type MatchStatus, findExactClientSumMatches, montoDistance, NAME_MATCH_THRESHOLD } from './voucher-matching'
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

function mediaTimeout(): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Media download timed out after 15s')), MEDIA_TIMEOUT_MS),
  )
}

function formatMonto(n: number): string {
  return `$${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function labelForIndex(i: number): string {
  return String.fromCharCode(65 + i)
}

function formatCandidatesMessage(cands: MatchVoucherCandidate[], monto: number | null): string {
  const clientesUnicos = new Set(cands.map(c => c.cliente_nombre)).size
  const intro = monto && monto > 0
    ? `Recibimos un pago de ${formatMonto(monto)}. Hay ${clientesUnicos} clientes posibles con facturas cercanas a ese monto.\n\n`
    : 'Comprobante con las siguientes facturas pendientes:\n\n'
  return intro +
    cands.map((c, i) => `${labelForIndex(i)}. ${c.cliente_nombre} — Factura ${c.numero_factura} — Saldo: ${formatMonto(c.saldo_pendiente)}`).join('\n') +
    '\n\nRespondé con la letra de la opción (A, B, C...).'
}

function formatMultiInvoiceMessage(
  candidates: MatchVoucherCandidate[],
  monto: number | null,
  clientName: string,
): string {
  const total = candidates.reduce((s, c) => s + c.saldo_pendiente, 0)
  return `Tu pago de ${formatMonto(monto ?? total)} coincide exactamente con el saldo total de ${clientName}. ¿Confirmás que querés pagar estas facturas?\n\n` +
    candidates.map((c, i) => `${labelForIndex(i)}. ${c.cliente_nombre} — Factura ${c.numero_factura} — Saldo: ${formatMonto(c.saldo_pendiente)}`).join('\n') +
    '\n\nRespondé "sí" o la letra de cada factura (ej: A, B).'
}

function normalizeDate(isoDate: string | null | undefined): string {
  if (!isoDate) return new Date().toISOString().slice(0, 10)
  const parts = isoDate.trim().split(/[-/]/)
  if (parts.length === 3) {
    if (parts[0] && parts[0].length === 4) {
      return `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`
    }
    if (parts[2] && parts[2].length === 4) {
      return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`
    }
  }
  return isoDate
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

function interpretUserResponse(
  text: string,
  candidates: MatchVoucherCandidate[],
): MatchVoucherCandidate | null {
  const cleaned = text.trim().toLowerCase()

  // Confirmation words are not letter/invoice/name selections
  if (/^(si|sí|confirmo?|ok|dale|adelante|todos?|todas)$/i.test(cleaned)) {
    return null
  }

  // Try matching by letter (A, B, C, ...)
  if (/^[a-z]$/.test(cleaned)) {
    const idx = cleaned.charCodeAt(0) - 97
    if (idx >= 0 && idx < candidates.length) {
      return candidates[idx]
    }
  }

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

  // Try matching by letters (A, B, AB, A,B, a b, etc.)
  const letterMatch = cleaned.match(/^[a-z\s,.\-]+$/)
  if (letterMatch) {
    const chars = cleaned.replace(/[^a-z]/g, '').split('')
    if (chars.length > 0 && chars.length <= candidates.length) {
      const indices = chars.map(c => c.charCodeAt(0) - 97).filter(i => i >= 0 && i < candidates.length)
      if (indices.length > 0) {
        return [...new Set(indices)].map(i => candidates[i])
      }
    }
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
  // Prefer multi_invoice items so "si" goes to the right handler
  const pendingItem = ctx.pending.find(p => p.multiInvoice) || (ctx.pending.length > 0 ? ctx.pending[0] : null)
  if (pendingItem && (message.type === 'text' || message.text)) {
    const userText = message.text || ''
    console.log('[voucher] User reply to clarification: "%s" (pending msg=%s multiInvoice=%s)', userText, pendingItem.sourceMessageId, pendingItem.multiInvoice)

    if (pendingItem.multiInvoice) {
      const selected = interpretMultiInvoiceResponse(userText, pendingItem.candidates)
      if (selected.length > 0) {
        await removePendingVoucher(db, conversationId, pendingItem.sourceMessageId)
        const fechaPago = normalizeDate(pendingItem.extraction.fecha)
        const paidList: string[] = []
        const errors: string[] = []
        let remaining = pendingItem.extraction.monto ?? 0

        for (const inv of selected) {
          const pago = Math.min(remaining, inv.saldo_pendiente)
          if (pago <= 0) continue

          try {
            await registrarPago({
              invoiceId: inv.invoice_id,
              monto: pago,
              fecha: fechaPago,
              entityType: pendingItem.bestDestination?.entity_type ?? undefined,
              entityId: pendingItem.bestDestination?.entity_id ?? undefined,
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
            reply += `\n\nQuedó un saldo de ${formatMonto(remaining)} sin asignar.`
          }
          if (errors.length > 0) {
            reply += `\n\nErrores al registrar:\n${errors.join('\n')}`
          }
          await notify({ ...sendCtx, text: reply })
        } else {
          await notify({ ...sendCtx, text: 'No se pudo registrar ningún pago.' })
        }
      } else {
        const lines = pendingItem.candidates.map(
          (c, i) => `${labelForIndex(i)}. ${c.cliente_nombre} — Factura ${c.numero_factura} — Saldo: $${c.saldo_pendiente.toLocaleString('es-AR')}`,
        )
        await notify({
          ...sendCtx,
          text: 'No entendimos tu respuesta. Respondé con las letras separadas por coma (ej: A, B) o decí "todas".\n\n' + lines.join('\n'),
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
          entity_type: pendingItem.bestDestination?.entity_type ?? null,
          entity_id: pendingItem.bestDestination?.entity_id ?? null,
          entity_name: pendingItem.bestDestination?.entity_name ?? null,
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

        const montoPago = pendingItem.extraction.monto ?? chosen.saldo_pendiente
        if (montoPago > 0) {
          try {
            const fechaPago = normalizeDate(pendingItem.extraction.fecha)
            await registrarPago({
              invoiceId: chosen.invoice_id,
              monto: montoPago,
              fecha: fechaPago,
              entityType: pendingItem.bestDestination?.entity_type ?? undefined,
              entityId: pendingItem.bestDestination?.entity_id ?? undefined,
            })
            console.log('[voucher] Payment registered after clarification: invoice=%s amount=%s', chosen.invoice_id, montoPago)
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            console.error('[voucher] PAYMENT after clarification failed:', msg)
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[voucher] STAGING after clarification failed:', msg)
      }

      await notify({
        ...sendCtx,
        text: `Confirmado. Pago de ${formatMonto(pendingItem.extraction.monto ?? chosen.saldo_pendiente)} registrado para ${chosen.cliente_nombre} — Factura ${chosen.numero_factura}.`,
      })
    } else {
      const lines = pendingItem.candidates.map(
        (c, i) => `${labelForIndex(i)}. ${c.cliente_nombre} — Factura ${c.numero_factura} — Saldo: $${c.saldo_pendiente.toLocaleString('es-AR')}`,
      )
      await notify({
        ...sendCtx,
        text: 'No entendimos tu respuesta. Respondé con la letra de la opción (A, B, C...).\n\n' + lines.join('\n'),
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
    await notify({ ...sendCtx, text: 'No pudimos descargar la imagen.' })
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
  let candidates: MatchVoucherCandidate[] = []
  const allDestinationCandidates: DestinationCandidate[] = []
  let bestDest: DestinationCandidate | null = null
  let mensajeRespuesta = 'Error inesperado al procesar el comprobante.'
  let errorMessage: string | null = null
  const debugInfo: Record<string, unknown> = {
    phase1: null,
    phase2: null,
    phase3: null,
    final: null,
  }

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
    // Candidate pool — accumulates unique matches across phases 1-3
    interface PoolEntry {
      type: 'single' | 'sum'
      invoices: MatchVoucherCandidate[]
      total: number
      clientName: string
    }
    const candidatePool: PoolEntry[] = []
    const poolInvoiceIds = new Set<number>()

    function tryAddToPool(entry: PoolEntry): boolean {
      for (const inv of entry.invoices) {
        if (poolInvoiceIds.has(inv.invoice_id)) return false
      }
      for (const inv of entry.invoices) {
        poolInvoiceIds.add(inv.invoice_id)
      }
      candidatePool.push(entry)
      return true
    }

    // Store Phase 1 candidates for Phase 2 reuse
    let amountCandidatesP1: MatchVoucherCandidate[] = []
    // Store Phase 3 candidates for name-based disambiguation (Phase 4)
    let nameCandidates: MatchVoucherCandidate[] = []

    // ── Phase 1: Exact amount (individual invoices) ──
    if (voucher.monto && voucher.monto > 0) {
      console.log('[voucher-debug] === Phase 1: Exact amount ===')
      console.log('[voucher-debug]   monto=%s', voucher.monto)
      const p1steps: Record<string, unknown>[] = []
      try {
        const amountResult = await matchVoucherByName({
          nombre_cliente: null,
          nombre_origen: null,
          nombre_destino: voucher.nombre_destino ?? null,
          cbu_destino: voucher.cbu_destino ?? null,
          cuit_destino: voucher.cuit_destino ?? null,
          monto: voucher.monto,
          tolerancia: 50,
          timeoutMs: 60_000,
        })
        amountCandidatesP1 = amountResult.invoice_candidates || []
        if (amountResult.destination_candidates?.length) {
          allDestinationCandidates.push(...amountResult.destination_candidates)
        }
        console.log('[voucher-debug] Phase 1 API: %d candidates, %d destinations', amountCandidatesP1.length, amountResult.destination_candidates?.length || 0)
        const phase1ApiResult = amountCandidatesP1.map(c => ({
          factura: c.numero_factura,
          cliente: c.cliente_nombre,
          saldo: c.saldo_pendiente,
          score: c.score,
        }))
        if (amountCandidatesP1.length > 0) {
          console.table(phase1ApiResult)
        }

        let exactCount = 0
        for (const c of amountCandidatesP1) {
          if (montoDistance(voucher.monto!, c.saldo_pendiente) === 0) {
            if (tryAddToPool({ type: 'single', invoices: [c], total: c.saldo_pendiente, clientName: c.cliente_nombre })) {
              exactCount++
            }
          }
        }

        p1steps.push({
          step: 'Exact amount',
          input: phase1ApiResult,
          result: { apiCandidates: amountCandidatesP1.length, exactMatches: exactCount },
        })
        console.log('[voucher-debug] Phase 1: %d exact matches added to pool', exactCount)

        debugInfo.phase1 = {
          apiCall: { monto: voucher.monto, tolerancia: 50 },
          apiResult: phase1ApiResult,
          steps: p1steps,
          result: { apiCandidates: amountCandidatesP1.length, poolAdded: exactCount },
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[voucher-debug] Phase 1 search FAILED:', msg)
        console.error('[voucher] Phase 1 search failed:', msg)
        errorMessage = [errorMessage, `Phase1: ${msg}`].filter(Boolean).join(' | ')
      }
    }

    // ── Phase 2: Exact sum of same client invoices ──
    if (voucher.monto && voucher.monto > 0) {
      console.log('[voucher-debug] === Phase 2: Exact sum of client invoices ===')
      const p2steps: Record<string, unknown>[] = []
      try {
        // Search ALL invoices with saldo in [0, 2*monto] so we can find
        // clients whose combined invoices sum to the voucher amount exactly.
        // Individual >= monto would already be caught by Phase 1.
        const p2Tolerancia = voucher.monto
        console.log('[voucher-debug] Phase 2 API: tolerancia=%s (full scan)', p2Tolerancia)
        const p2Result = await matchVoucherByName({
          nombre_cliente: null,
          nombre_origen: null,
          nombre_destino: voucher.nombre_destino ?? null,
          cbu_destino: voucher.cbu_destino ?? null,
          cuit_destino: voucher.cuit_destino ?? null,
          monto: voucher.monto,
          tolerancia: p2Tolerancia,
          timeoutMs: 60_000,
        })
        const allCandidates = (p2Result.invoice_candidates || [])
          .filter(c => c.saldo_pendiente < voucher.monto!)
        if (p2Result.destination_candidates?.length) {
          allDestinationCandidates.push(...p2Result.destination_candidates)
        }
        console.log('[voucher-debug] Phase 2 API: %d total candidates, %d with saldo < monto', (p2Result.invoice_candidates || []).length, allCandidates.length)
        const p2ApiResult = allCandidates.map(c => ({
          factura: c.numero_factura,
          cliente: c.cliente_nombre,
          saldo: c.saldo_pendiente,
          score: c.score,
        }))
        if (allCandidates.length > 0) {
          console.table(p2ApiResult)
        }

        const exactSums = findExactClientSumMatches(voucher.monto, allCandidates)
        let sumCount = 0
        for (const group of exactSums) {
          if (tryAddToPool({ type: 'sum', invoices: group.invoices, total: group.total, clientName: group.clientName })) {
            sumCount++
          }
        }

        p2steps.push({
          step: 'Exact sum',
          result: { totalGroups: exactSums.length, addedToPool: sumCount, groups: exactSums.map(s => ({ clientName: s.clientName, total: s.total, invoices: s.invoices.map(i => i.numero_factura) })) },
        })
        console.log('[voucher-debug] Phase 2: %d sum groups added to pool', sumCount)

        debugInfo.phase2 = {
          apiCall: { monto: voucher.monto, tolerancia: p2Tolerancia },
          apiResult: p2ApiResult,
          steps: p2steps,
          result: { groupsFound: exactSums.length, poolAdded: sumCount },
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[voucher-debug] Phase 2 search FAILED:', msg)
        console.error('[voucher] Phase 2 search failed:', msg)
        errorMessage = [errorMessage, `Phase2: ${msg}`].filter(Boolean).join(' | ')
      }
    }

    // ── Phase 3: Name-based + exact amount ──
    if (voucher.nombre_cliente || voucher.nombre_origen) {
      console.log('[voucher-debug] === Phase 3: Name + amount ===')
      console.log('[voucher-debug]   nombre_cliente="%s" nombre_origen="%s" monto=%s',
        voucher.nombre_cliente, voucher.nombre_origen, voucher.monto)
      const p3steps: Record<string, unknown>[] = []
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
        nameCandidates = nameResult.invoice_candidates || []
        if (nameResult.destination_candidates?.length) {
          allDestinationCandidates.push(...nameResult.destination_candidates)
        }
        console.log('[voucher-debug] Phase 3 API: %d candidates, %d destinations', nameCandidates.length, nameResult.destination_candidates?.length || 0)
        const phase3ApiResult = nameCandidates.map(c => ({
          factura: c.numero_factura,
          cliente: c.cliente_nombre,
          saldo: c.saldo_pendiente,
          score: c.score,
        }))
        if (nameCandidates.length > 0) {
          console.table(phase3ApiResult)
        }

        let nameExactCount = 0
        for (const c of nameCandidates) {
          if (c.score >= NAME_MATCH_THRESHOLD) {
            if (tryAddToPool({ type: 'single', invoices: [c], total: c.saldo_pendiente, clientName: c.cliente_nombre })) {
              nameExactCount++
            }
          }
        }

        p3steps.push({
          step: 'Name match',
          input: phase3ApiResult,
          result: { apiCandidates: nameCandidates.length, exactWithName: nameExactCount },
        })
        console.log('[voucher-debug] Phase 3: %d name matches added to pool', nameExactCount)

        debugInfo.phase3 = {
          apiCall: { nombre_cliente: voucher.nombre_cliente, nombre_origen: voucher.nombre_origen, monto: voucher.monto, tolerancia: 50 },
          apiResult: phase3ApiResult,
          steps: p3steps,
          result: { apiCandidates: nameCandidates.length, poolAdded: nameExactCount },
          nameCandidates: nameCandidates.map(c => ({
            invoice_id: c.invoice_id,
            factura: c.numero_factura,
            cliente: c.cliente_nombre,
            saldo: c.saldo_pendiente,
            score: c.score,
          })),
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[voucher-debug] Phase 3 search FAILED:', msg)
        console.error('[voucher] Phase 3 search failed:', msg)
        errorMessage = [errorMessage, `Phase3: ${msg}`].filter(Boolean).join(' | ')
      }
    }

    // ── Phase 4: Name-based resolution ──
    console.log('[voucher-debug] === Phase 4: Name resolution ===')
    console.log('[voucher-debug]   candidatePool size=%d', candidatePool.length)

    const p4steps: Record<string, unknown>[] = []
    const hasName = voucher.nombre_cliente?.trim()
                  || voucher.nombre_origen?.trim()
                  || voucher.nombre_destino?.trim()

    const nameIsReliable = nameCandidates.length > 0
      && nameCandidates.some(c => c.score >= NAME_MATCH_THRESHOLD)

    console.log('[voucher-debug] Phase 4: hasName=%s nameIsReliable=%s nameCands=%d',
      !!hasName, nameIsReliable, nameCandidates.length)

    // CASE A: Pool has multiple entries → narrow down by name
    if (candidatePool.length > 1 && nameIsReliable) {
      const highScoreIds = new Set(
        nameCandidates
          .filter(c => c.score >= NAME_MATCH_THRESHOLD)
          .map(c => c.invoice_id)
      )
      const filteredPool = candidatePool.filter(entry =>
        entry.invoices.some(inv => highScoreIds.has(inv.invoice_id))
      )
      if (filteredPool.length === 1) {
        candidatePool.length = 0
        candidatePool.push(...filteredPool)
        p4steps.push({ step: 'Narrow pool by name', result: { narrowedTo: 1 } })
        console.log('[voucher-debug] Phase 4: narrowed pool to 1 via name match')
      } else {
        p4steps.push({ step: 'Narrow pool by name', result: { narrowedTo: filteredPool.length, kept: filteredPool.length > 0 ? 'partial' : 'none' } })
      }
    }

    // CASE B: Pool is empty → try to add best name match
    if (candidatePool.length === 0 && nameIsReliable) {
      const bestMatch = nameCandidates
        .filter(c => c.score >= NAME_MATCH_THRESHOLD)
        .sort((a, b) => b.score - a.score)[0]
      if (bestMatch) {
        if (tryAddToPool({ type: 'single', invoices: [bestMatch], total: bestMatch.saldo_pendiente, clientName: bestMatch.cliente_nombre })) {
          p4steps.push({ step: 'Add best name match', result: { factura: bestMatch.numero_factura, cliente: bestMatch.cliente_nombre, score: bestMatch.score, saldo: bestMatch.saldo_pendiente, added: true } })
          console.log('[voucher-debug] Phase 4: added best name match (score=%s, saldo=%s)', bestMatch.score, bestMatch.saldo_pendiente)
        }
      }
    }

    // CASE C: Pool still empty AND name not reliable → ask directly
    if (candidatePool.length === 0 && !nameIsReliable) {
      matchStatus = 'ambiguous'
      mensajeRespuesta = voucher.monto && voucher.monto > 0
        ? `Recibimos un pago de ${formatMonto(voucher.monto)}. Decinos el nombre exacto del cliente para identificar la factura.`
        : 'Decinos el nombre exacto del cliente para identificar la factura.'
      p4steps.push({ step: 'Ask for client name', reason: 'name not reliable' })
      console.log('[voucher] Phase 4: no reliable name, asking for client name')
    }

    debugInfo.phase4 = {
      hasName: !!hasName,
      nameIsReliable,
      nameCandidatesCount: nameCandidates.length,
      bestNameScore: nameCandidates.length > 0
        ? Math.max(...nameCandidates.map(c => c.score)) : null,
      poolBefore: candidatePool.length,
      steps: p4steps,
      result: candidatePool.length,
    }

    // ── Decision after phase 4 ──
    console.log('[voucher-debug] === Decision after phase 4 ===')
    console.log('[voucher-debug]   candidatePool size=%d', candidatePool.length)

    if (candidatePool.length === 0 && matchStatus !== 'ambiguous') {
      // ── Phase 5: Wide search / partial payment ──
      console.log('[voucher-debug] === Phase 5: Wide search / partial payment ===')
      let phase4Cands: MatchVoucherCandidate[] = []
      let phase4Timeout = false

      try {
        const wideTolerancia = Math.min(Math.max(10_000, (voucher.monto ?? 0) * 0.5), 50_000)
        console.log('[voucher-debug] Phase 5: wide search tolerancia=%s', wideTolerancia)
        const wideResult = await matchVoucherByName({
          nombre_cliente: null,
          nombre_origen: null,
          nombre_destino: voucher.nombre_destino ?? null,
          cbu_destino: voucher.cbu_destino ?? null,
          cuit_destino: voucher.cuit_destino ?? null,
          monto: voucher.monto,
          tolerancia: wideTolerancia,
        })
        phase4Cands = wideResult.invoice_candidates || []
        if (wideResult.destination_candidates?.length) {
          allDestinationCandidates.push(...wideResult.destination_candidates)
        }
        // Filter to invoices with saldo >= monto (no overpayments)
        phase4Cands = phase4Cands.filter(c => c.saldo_pendiente >= (voucher.monto ?? 0))
        console.log('[voucher-debug] Phase 5: wide search returned %d candidates, %d destinations (after saldo>=monto filter)', phase4Cands.length, wideResult.destination_candidates?.length || 0)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[voucher-debug] Phase 5 wide search failed:', msg)
        phase4Timeout = true
      }

      if (phase4Cands.length > 0 && phase4Cands.length <= 15) {
        // Manageable — show all to user
        candidates = phase4Cands
        matchStatus = 'ambiguous'
        const clientesUnicos = new Set(phase4Cands.map(c => c.cliente_nombre)).size
        console.table(phase4Cands.map(c => ({
          factura: c.numero_factura,
          cliente: c.cliente_nombre,
          saldo: c.saldo_pendiente,
        })))
        const intro = voucher.monto && voucher.monto > 0
          ? `Recibimos un pago de ${formatMonto(voucher.monto)}. Hay ${clientesUnicos} clientes posibles con facturas cercanas a ese monto.\n\n`
          : 'No pudimos leer el monto del comprobante. Estas son las facturas pendientes:\n\n'
        mensajeRespuesta = intro +
          phase4Cands.map((c, i) => `${labelForIndex(i)}. ${c.cliente_nombre} — Factura ${c.numero_factura} — Saldo: ${formatMonto(c.saldo_pendiente)}`).join('\n') +
          '\n\nRespondé con la letra de la opción (A, B, C...).'
        console.log('[voucher] Phase 5: showing %d candidates (%d clients) to user', phase4Cands.length, clientesUnicos)
      } else if (phase4Cands.length > 15 || phase4Timeout) {
        // Too many or timeout — ask for exact client name first
        matchStatus = 'ambiguous'
        mensajeRespuesta = voucher.monto && voucher.monto > 0
          ? `Recibimos un pago de ${formatMonto(voucher.monto)}. Decinos el nombre exacto del cliente para identificar la factura.`
          : 'Decinos el nombre exacto del cliente para identificar la factura.'
        console.log('[voucher] Phase 5: asking for client name (%d cands, timeout=%s)', phase4Cands.length, phase4Timeout)
      } else {
        console.log('[voucher-debug] Phase 5: no candidates found')
        matchStatus = 'no_match'
        mensajeRespuesta = voucher.monto && voucher.monto > 0
          ? `Recibimos un pago de ${formatMonto(voucher.monto)} pero no encontramos ninguna factura pendiente. Un agente lo revisará.`
          : 'No pudimos leer el monto del comprobante. Un agente lo revisará.'
      }

      debugInfo.phase5 = {
        wideSearch: { tolerancia: Math.min(Math.max(10_000, (voucher.monto ?? 0) * 0.5), 50_000), candidates: phase4Cands.length, timeout: phase4Timeout },
        result: { status: matchStatus, candidatesShown: phase4Cands.length > 0 && phase4Cands.length <= 15 ? phase4Cands.length : 0 },
      }
    } else if (candidatePool.length === 1) {
      const entry = candidatePool[0]
      if (entry.type === 'single') {
        const bestInvoice = entry.invoices[0]
        const nombreExtraido = voucher.nombre_origen?.trim() || voucher.nombre_cliente?.trim() || null
        if (nombreExtraido && bestInvoice.score < NAME_MATCH_THRESHOLD) {
          matchStatus = 'ambiguous'
          candidates = entry.invoices
          mensajeRespuesta = `El pago de ${formatMonto(entry.total)} coincide exactamente con la factura ${bestInvoice.numero_factura} de ${bestInvoice.cliente_nombre}, pero el nombre del remitente es "${nombreExtraido}". \n\n¿Es correcto? Respondé "sí" para confirmar.`
          console.log('[voucher-debug] Decision: ambiguous (name_mismatch, invoice=%s, nombre="%s", score=%s)', bestInvoice.numero_factura, nombreExtraido, bestInvoice.score)
        } else {
          matchStatus = 'matched'
          matchedInvoiceId = bestInvoice.invoice_id
          matchedInvoiceNumero = bestInvoice.numero_factura
          matchedClienteNombre = bestInvoice.cliente_nombre
          matchedSaldoPendiente = bestInvoice.saldo_pendiente
          candidates = entry.invoices
          mensajeRespuesta = bestInvoice.cliente_nombre
            ? `Confirmado. Pago de ${formatMonto(entry.total)} registrado para ${bestInvoice.cliente_nombre} — Factura ${bestInvoice.numero_factura}.`
            : `Confirmado. Pago de ${formatMonto(entry.total)} registrado para la factura ${bestInvoice.numero_factura}.`
          console.log('[voucher-debug] Decision: matched (single exact, invoice=%s)', bestInvoice.numero_factura)
        }
      } else {
        matchStatus = 'multi_invoice'
        candidates = entry.invoices
        mensajeRespuesta = formatMultiInvoiceMessage(entry.invoices, voucher.monto, entry.clientName)
        console.log('[voucher-debug] Decision: multi_invoice (exact sum, client=%s, invoices=%d)', entry.clientName, entry.invoices.length)
      }
    } else {
      // Multiple pool entries — show all to user
      matchStatus = 'ambiguous'
      candidates = candidatePool.flatMap(e => e.invoices)
      const lineas = candidatePool.map((e, i) => {
        if (e.type === 'single') {
          return `${labelForIndex(i)}. ${e.clientName} — Factura ${e.invoices[0].numero_factura} — Saldo: ${formatMonto(e.total)}`
        }
        return `${labelForIndex(i)}. ${e.clientName} — Suma de ${e.invoices.length} facturas: ${formatMonto(e.total)}`
      })
      const intro = `Recibimos un pago de ${formatMonto(voucher.monto ?? candidatePool[0].total)}. ${candidatePool.length} opciones posibles:\n\n`
      mensajeRespuesta = intro + lineas.join('\n') + '\n\nRespondé con la letra de la opción (A, B, C...).'
      console.log('[voucher-debug] Decision: ambiguous (%d pool entries)', candidatePool.length)
    }

    debugInfo.decision = {
      poolSize: candidatePool.length,
      entries: candidatePool.map(e => ({
        type: e.type,
        clientName: e.clientName,
        total: e.total,
        invoiceCount: e.invoices.length,
      })),
      finalStatus: matchStatus,
    }

    console.log('[voucher-debug] === FINAL RESULT ===')
    console.log('[voucher-debug]   matchStatus=%s', matchStatus)
    console.log('[voucher-debug]   matchedInvoiceId=%s', matchedInvoiceId)
    console.log('[voucher-debug]   matchedInvoiceNumero=%s', matchedInvoiceNumero)
    console.log('[voucher-debug]   matchedClienteNombre=%s', matchedClienteNombre)
    console.log('[voucher-debug]   matchedSaldoPendiente=%s', matchedSaldoPendiente)
    console.log('[voucher-debug]   errorMessage=%s', errorMessage)
    console.log('[voucher-debug]   mensajeRespuesta: %s', mensajeRespuesta)

    debugInfo.final = {
      matchStatus,
      matchedInvoiceId,
      matchedInvoiceNumero,
      matchedClienteNombre,
      matchedSaldoPendiente,
      errorMessage,
    }

    bestDest = allDestinationCandidates.length > 0
      ? allDestinationCandidates.reduce((a, b) => a.score >= b.score ? a : b)
      : null
    if (bestDest) {
      debugInfo.final_destination = {
        entity_type: bestDest.entity_type,
        entity_id: bestDest.entity_id,
        entity_name: bestDest.entity_name,
        match_field: bestDest.match_field,
        score: bestDest.score,
      }
    }
    console.log('[voucher-debug]   destinationCandidates=%d bestDest=%s',
      allDestinationCandidates.length,
      bestDest ? `${bestDest.entity_type}:${bestDest.entity_id} (${bestDest.entity_name}, score=${bestDest.score})` : 'none')

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[voucher] EXTRACTION failed:', msg)
    errorMessage = `Extraction: ${msg}`
    matchStatus = 'no_match'
    mensajeRespuesta =
      'Gracias por tu comprobante. No pudimos leerlo automáticamente.'
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
        entity_type: bestDest?.entity_type ?? null,
        entity_id: bestDest?.entity_id ?? null,
        entity_name: bestDest?.entity_name ?? null,
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
      const fechaPago = normalizeDate(extractedDate)
      await registrarPago({
        invoiceId: matchedInvoiceId,
        monto: extractedAmount,
        fecha: fechaPago,
        entityType: bestDest?.entity_type ?? undefined,
        entityId: bestDest?.entity_id ?? undefined,
      })
      console.log('[voucher] Payment registered OK invoice=%s amount=%s', matchedInvoiceId, extractedAmount)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[voucher] PAYMENT_FAILED:', msg)
      errorMessage = [errorMessage, `Payment: ${msg}`].filter(Boolean).join(' | ')
      // The review is staged as 'completed' but payment failed — let user know
      mensajeRespuesta = 'Registramos el comprobante pero hubo un error al crear el pago.'
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
      bestDestination: bestDest,
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
          const fechaPago = normalizeDate(extractedDate)
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
                entityType: bestDest?.entity_type ?? undefined,
                entityId: bestDest?.entity_id ?? undefined,
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
              reply += `\n\nQuedó un saldo de $${remaining.toLocaleString('es-AR')} sin asignar.`
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
      bestDestination: bestDest,
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
            entity_type: bestDest?.entity_type ?? null,
            entity_id: bestDest?.entity_id ?? null,
            entity_name: bestDest?.entity_name ?? null,
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

          const montoAuto = extractedAmount ?? autoChosen.saldo_pendiente
          if (montoAuto > 0) {
            try {
              const fechaAuto = normalizeDate(extractedDate)
              await registrarPago({
                invoiceId: autoChosen.invoice_id,
                monto: montoAuto,
                fecha: fechaAuto,
                entityType: bestDest?.entity_type ?? undefined,
                entityId: bestDest?.entity_id ?? undefined,
              })
              console.log('[voucher] Payment auto-registered: invoice=%s amount=%s', autoChosen.invoice_id, montoAuto)
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              console.error('[voucher] Auto payment failed:', msg)
            }
          }

          mensajeRespuesta = `Confirmado. Pago de ${formatMonto(montoAuto)} registrado para ${autoChosen.cliente_nombre} — Factura ${autoChosen.numero_factura}.`
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

  // ── Defer: skip candidates message if other pending items exist ──
  if ((matchStatus === 'ambiguous' || matchStatus === 'multi_invoice') && candidates.length > 0) {
    const currentCtx = await loadVoucherContext(db, conversationId)
    const otherPending = currentCtx.pending.filter(p => p.sourceMessageId !== message.id)
    if (otherPending.length > 0) {
      mensajeRespuesta = extractedAmount && extractedAmount > 0
        ? `Recibimos tu comprobante de ${formatMonto(extractedAmount)}. Hay comprobantes anteriores pendientes, te consultaremos cuando los resolvamos.`
        : 'Comprobante guardado. Te consultaremos cuando resolvamos los anteriores.'
      console.log('[voucher] Deferred showing candidates due to %d other pending items', otherPending.length)
    }
  }

  // ── Next pending: if resolved and more items in queue, show the next ──
  if ((matchStatus === 'matched' || matchStatus === 'multi_invoice') && candidates.length > 0) {
    const updatedCtx = await loadVoucherContext(db, conversationId)
    if (updatedCtx.pending.length > 0) {
      const nextItem = updatedCtx.pending[0]
      const nextMsg = nextItem.multiInvoice
        ? formatMultiInvoiceMessage(nextItem.candidates, nextItem.extraction.monto, nextItem.candidates[0]?.cliente_nombre || '')
        : formatCandidatesMessage(nextItem.candidates, nextItem.extraction.monto)
      mensajeRespuesta = `El comprobante fue procesado.\n\nAhora, para el siguiente comprobante:\n${nextMsg}`
      console.log('[voucher] Showing next pending item (%d remaining)', updatedCtx.pending.length)
    }
  }

  // ── Safety: if no candidates, strip any selection prompt ──
  if (candidates.length === 0 && matchStatus !== 'matched') {
    if (mensajeRespuesta.includes('Respondé con la letra') || mensajeRespuesta.includes('Respondé con el código')) {
      mensajeRespuesta = extractedAmount && extractedAmount > 0
        ? `Recibimos un pago de ${formatMonto(extractedAmount)} pero no encontramos ninguna factura pendiente. Un agente lo revisará.`
        : 'No pudimos leer el monto del comprobante. Un agente lo revisará.'
    }
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
    debugInfo,
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
  debugInfo?: Record<string, unknown>
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
      debug_info: args.debugInfo ?? null,
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
