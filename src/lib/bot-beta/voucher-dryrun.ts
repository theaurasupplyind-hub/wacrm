// COPIADO de src/lib/ai/voucher-pipeline.ts:445-846 @ 2026-08-27
// Versión aislada para Bot Beta — SOLO LECTURA + PREVIEW, nunca escribe.
// No toca pipeline de producción. Mantener sync manual si prod cambia.

import { matchVoucherByName } from '@/lib/facbal/client'
import type { MatchVoucherCandidate, DestinationCandidate } from '@/lib/facbal/client'
import { findExactClientSumMatches, montoDistance, NAME_MATCH_THRESHOLD } from '@/lib/ai/voucher-matching'

export interface VoucherDryInput {
  monto: number | null
  fecha: string | null
  referencia: string | null
  banco: string | null
  nombre_cliente: string | null
  nombre_origen: string | null
  nombre_destino: string | null
  cbu_destino: string | null
  cuit_destino: string | null
}

export interface VoucherDryResult {
  matchStatus: 'matched' | 'ambiguous' | 'no_match' | 'multi_invoice'
  candidates: MatchVoucherCandidate[]
  matchedInvoiceId: number | null
  matchedInvoiceNumero: string | null
  matchedClienteNombre: string | null
  matchedSaldoPendiente: number | null
  bestDestination: DestinationCandidate | null
  mensajeRespuesta: string
  debugInfo: Record<string, unknown>
  errorMessage: string | null
}

function formatMonto(n: number): string {
  return `$${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatCandidatesMessage(cands: MatchVoucherCandidate[], monto: number | null): string {
  const clientesUnicos = new Set(cands.map(c => c.cliente_nombre)).size
  const intro = monto && monto > 0
    ? `Recibimos un pago de ${formatMonto(monto)}. Hay ${clientesUnicos} clientes posibles con facturas cercanas a ese monto.\n\n`
    : 'Comprobante con las siguientes facturas pendientes:\n\n'
  return intro + cands.map((c, i) => `${String.fromCharCode(65 + i)}. ${c.cliente_nombre} — Factura ${c.numero_factura} — Saldo: ${formatMonto(c.saldo_pendiente)}`).join('\n') + '\n\nRespondé con la letra de la opción (A, B, C...).'
}

function formatMultiInvoiceMessage(candidates: MatchVoucherCandidate[], monto: number | null, clientName: string): string {
  const total = candidates.reduce((s, c) => s + c.saldo_pendiente, 0)
  return `Tu pago de ${formatMonto(monto ?? total)} coincide exactamente con el saldo total de ${clientName}. ¿Confirmás que querés pagar estas facturas?\n\n` + candidates.map((c, i) => `${String.fromCharCode(65 + i)}. ${c.cliente_nombre} — Factura ${c.numero_factura} — Saldo: ${formatMonto(c.saldo_pendiente)}`).join('\n') + '\n\nRespondé "sí" o la letra de cada factura (ej: A, B).'
}

export async function runVoucherDryRun(input: VoucherDryInput): Promise<VoucherDryResult> {
  let extractedAmount = input.monto
  let matchStatus: VoucherDryResult['matchStatus'] = 'no_match'
  let matchedInvoiceId: number | null = null
  let matchedInvoiceNumero: string | null = null
  let matchedClienteNombre: string | null = null
  let matchedSaldoPendiente: number | null = null
  let candidates: MatchVoucherCandidate[] = []
  const allDestinationCandidates: DestinationCandidate[] = []
  let bestDest: DestinationCandidate | null = null
  let mensajeRespuesta = 'Error inesperado.'
  let errorMessage: string | null = null
  const debugInfo: Record<string, unknown> = { phase1: null, phase2: null, phase3: null, final: null }

  try {
    interface PoolEntry { type: 'single' | 'sum'; invoices: MatchVoucherCandidate[]; total: number; clientName: string }
    const candidatePool: PoolEntry[] = []
    const poolInvoiceIds = new Set<number>()
    function tryAddToPool(entry: PoolEntry): boolean {
      for (const inv of entry.invoices) if (poolInvoiceIds.has(inv.invoice_id)) return false
      for (const inv of entry.invoices) poolInvoiceIds.add(inv.invoice_id)
      candidatePool.push(entry)
      return true
    }
    let amountCandidatesP1: MatchVoucherCandidate[] = []
    let nameCandidates: MatchVoucherCandidate[] = []

    // Phase 1: Exact amount
    if (input.monto && input.monto > 0) {
      const p1steps: Record<string, unknown>[] = []
      try {
        const amountResult = await matchVoucherByName({
          nombre_cliente: null, nombre_origen: null, nombre_destino: input.nombre_destino ?? null,
          cbu_destino: input.cbu_destino ?? null, cuit_destino: input.cuit_destino ?? null,
          monto: input.monto, tolerancia: 50, timeoutMs: 60000,
        })
        amountCandidatesP1 = amountResult.invoice_candidates || []
        if (amountResult.destination_candidates?.length) allDestinationCandidates.push(...amountResult.destination_candidates)
        const phase1ApiResult = amountCandidatesP1.map(c => ({ factura: c.numero_factura, cliente: c.cliente_nombre, saldo: c.saldo_pendiente, score: c.score }))
        let exactCount = 0
        for (const c of amountCandidatesP1) if (montoDistance(input.monto!, c.saldo_pendiente) === 0) if (tryAddToPool({ type: 'single', invoices: [c], total: c.saldo_pendiente, clientName: c.cliente_nombre })) exactCount++
        p1steps.push({ step: 'Exact amount', input: phase1ApiResult, result: { apiCandidates: amountCandidatesP1.length, exactMatches: exactCount } })
        debugInfo.phase1 = { apiCall: { monto: input.monto, tolerancia: 50 }, apiResult: phase1ApiResult, steps: p1steps, result: { apiCandidates: amountCandidatesP1.length, poolAdded: exactCount } }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errorMessage = [errorMessage, `Phase1: ${msg}`].filter(Boolean).join(' | ')
      }
    }

    // Phase 2: Exact sum
    if (input.monto && input.monto > 0) {
      const p2steps: Record<string, unknown>[] = []
      try {
        const p2Tolerancia = input.monto
        const p2Result = await matchVoucherByName({
          nombre_cliente: null, nombre_origen: null, nombre_destino: input.nombre_destino ?? null,
          cbu_destino: input.cbu_destino ?? null, cuit_destino: input.cuit_destino ?? null,
          monto: input.monto, tolerancia: p2Tolerancia, timeoutMs: 60000,
        })
        const allCandidates = (p2Result.invoice_candidates || []).filter(c => c.saldo_pendiente < input.monto!)
        if (p2Result.destination_candidates?.length) allDestinationCandidates.push(...p2Result.destination_candidates)
        const p2ApiResult = allCandidates.map(c => ({ factura: c.numero_factura, cliente: c.cliente_nombre, saldo: c.saldo_pendiente, score: c.score }))
        const exactSums = findExactClientSumMatches(input.monto, allCandidates)
        let sumCount = 0
        for (const group of exactSums) if (tryAddToPool({ type: 'sum', invoices: group.invoices, total: group.total, clientName: group.clientName })) sumCount++
        p2steps.push({ step: 'Exact sum', result: { totalGroups: exactSums.length, addedToPool: sumCount, groups: exactSums.map(s => ({ clientName: s.clientName, total: s.total, invoices: s.invoices.map(i => i.numero_factura) })) } })
        debugInfo.phase2 = { apiCall: { monto: input.monto, tolerancia: p2Tolerancia }, apiResult: p2ApiResult, steps: p2steps, result: { groupsFound: exactSums.length, poolAdded: sumCount } }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errorMessage = [errorMessage, `Phase2: ${msg}`].filter(Boolean).join(' | ')
      }
    }

    // Phase 3: Name + amount
    if (input.nombre_cliente || input.nombre_origen) {
      const p3steps: Record<string, unknown>[] = []
      try {
        const nameResult = await matchVoucherByName({
          nombre_cliente: input.nombre_cliente, nombre_origen: input.nombre_origen,
          nombre_destino: input.nombre_destino, cbu_destino: input.cbu_destino, cuit_destino: input.cuit_destino,
          monto: input.monto, tolerancia: 50,
        })
        nameCandidates = nameResult.invoice_candidates || []
        if (nameResult.destination_candidates?.length) allDestinationCandidates.push(...nameResult.destination_candidates)
        const phase3ApiResult = nameCandidates.map(c => ({ factura: c.numero_factura, cliente: c.cliente_nombre, saldo: c.saldo_pendiente, score: c.score }))
        let nameExactCount = 0
        for (const c of nameCandidates) if (c.score >= NAME_MATCH_THRESHOLD) if (tryAddToPool({ type: 'single', invoices: [c], total: c.saldo_pendiente, clientName: c.cliente_nombre })) nameExactCount++
        p3steps.push({ step: 'Name match', input: phase3ApiResult, result: { apiCandidates: nameCandidates.length, exactWithName: nameExactCount } })
        debugInfo.phase3 = { apiCall: { nombre_cliente: input.nombre_cliente, nombre_origen: input.nombre_origen, monto: input.monto, tolerancia: 50 }, apiResult: phase3ApiResult, steps: p3steps, result: { apiCandidates: nameCandidates.length, poolAdded: nameExactCount } }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errorMessage = [errorMessage, `Phase3: ${msg}`].filter(Boolean).join(' | ')
      }
    }

    // Phase 4: Name resolution
    const p4steps: Record<string, unknown>[] = []
    const hasName = input.nombre_cliente?.trim() || input.nombre_origen?.trim() || input.nombre_destino?.trim()
    const nameIsReliable = nameCandidates.length > 0 && nameCandidates.some(c => c.score >= NAME_MATCH_THRESHOLD)
    if (candidatePool.length > 1 && nameIsReliable) {
      const highScoreIds = new Set(nameCandidates.filter(c => c.score >= NAME_MATCH_THRESHOLD).map(c => c.invoice_id))
      const filteredPool = candidatePool.filter(entry => entry.invoices.some(inv => highScoreIds.has(inv.invoice_id)))
      if (filteredPool.length === 1) { candidatePool.length = 0; candidatePool.push(...filteredPool); p4steps.push({ step: 'Narrow pool by name', result: { narrowedTo: 1 } }) }
      else p4steps.push({ step: 'Narrow pool by name', result: { narrowedTo: filteredPool.length } })
    }
    if (candidatePool.length === 0 && nameIsReliable) {
      const bestMatch = nameCandidates.filter(c => c.score >= NAME_MATCH_THRESHOLD).sort((a, b) => b.score - a.score)[0]
      if (bestMatch) if (tryAddToPool({ type: 'single', invoices: [bestMatch], total: bestMatch.saldo_pendiente, clientName: bestMatch.cliente_nombre })) p4steps.push({ step: 'Add best name match', result: { factura: bestMatch.numero_factura, cliente: bestMatch.cliente_nombre, score: bestMatch.score } })
    }
    if (candidatePool.length === 0 && !nameIsReliable) {
      matchStatus = 'ambiguous'
      mensajeRespuesta = input.monto && input.monto > 0 ? `Recibimos un pago de ${formatMonto(input.monto)}. Decinos el nombre exacto del cliente para identificar la factura.` : 'Decinos el nombre exacto del cliente para identificar la factura.'
      p4steps.push({ step: 'Ask for client name', reason: 'name not reliable' })
    }
    debugInfo.phase4 = { hasName: !!hasName, nameIsReliable, nameCandidatesCount: nameCandidates.length, bestNameScore: nameCandidates.length > 0 ? Math.max(...nameCandidates.map(c => c.score)) : null, poolBefore: candidatePool.length, steps: p4steps, result: candidatePool.length }

    if (candidatePool.length === 0 && matchStatus !== 'ambiguous') {
      // Phase 5: Wide search
      let phase4Cands: MatchVoucherCandidate[] = []
      let phase4Timeout = false
      try {
        const wideTolerancia = Math.min(Math.max(10000, (input.monto ?? 0) * 0.5), 50000)
        const wideResult = await matchVoucherByName({
          nombre_cliente: null, nombre_origen: null, nombre_destino: input.nombre_destino ?? null,
          cbu_destino: input.cbu_destino ?? null, cuit_destino: input.cuit_destino ?? null,
          monto: input.monto, tolerancia: wideTolerancia,
        })
        phase4Cands = wideResult.invoice_candidates || []
        if (wideResult.destination_candidates?.length) allDestinationCandidates.push(...wideResult.destination_candidates)
        phase4Cands = phase4Cands.filter(c => c.saldo_pendiente >= (input.monto ?? 0))
      } catch { phase4Timeout = true }
      if (phase4Cands.length > 0 && phase4Cands.length <= 15) {
        candidates = phase4Cands
        matchStatus = 'ambiguous'
        const clientesUnicos = new Set(phase4Cands.map(c => c.cliente_nombre)).size
        mensajeRespuesta = (input.monto && input.monto > 0 ? `Recibimos un pago de ${formatMonto(input.monto)}. Hay ${clientesUnicos} clientes posibles con facturas cercanas a ese monto.\n\n` : 'No pudimos leer el monto. Estas son las facturas pendientes:\n\n') + phase4Cands.map((c, i) => `${String.fromCharCode(65 + i)}. ${c.cliente_nombre} — Factura ${c.numero_factura} — Saldo: ${formatMonto(c.saldo_pendiente)}`).join('\n') + '\n\nRespondé con la letra de la opción (A, B, C...).'
      } else if (phase4Cands.length > 15 || phase4Timeout) {
        matchStatus = 'ambiguous'
        mensajeRespuesta = input.monto && input.monto > 0 ? `Recibimos un pago de ${formatMonto(input.monto)}. Decinos el nombre exacto del cliente para identificar la factura.` : 'Decinos el nombre exacto del cliente para identificar la factura.'
      } else {
        matchStatus = 'no_match'
        mensajeRespuesta = input.monto && input.monto > 0 ? `Recibimos un pago de ${formatMonto(input.monto)} pero no encontramos ninguna factura pendiente. Un agente lo revisará.` : 'No pudimos leer el monto del comprobante. Un agente lo revisará.'
      }
      debugInfo.phase5 = { wideSearch: { candidates: phase4Cands.length, timeout: phase4Timeout }, result: { status: matchStatus, candidatesShown: phase4Cands.length > 0 && phase4Cands.length <= 15 ? phase4Cands.length : 0 } }
    } else if (candidatePool.length === 1) {
      const entry = candidatePool[0]
      if (entry.type === 'single') {
        const bestInvoice = entry.invoices[0]
        const nombreExtraido = input.nombre_origen?.trim() || input.nombre_cliente?.trim() || null
        if (nombreExtraido && bestInvoice.score < NAME_MATCH_THRESHOLD) {
          matchStatus = 'ambiguous'
          candidates = entry.invoices
          mensajeRespuesta = `El pago de ${formatMonto(entry.total)} coincide exactamente con la factura ${bestInvoice.numero_factura} de ${bestInvoice.cliente_nombre}, pero el nombre del remitente es "${nombreExtraido}". \n\n¿Es correcto? Respondé "sí" para confirmar.`
        } else {
          matchStatus = 'matched'
          matchedInvoiceId = bestInvoice.invoice_id
          matchedInvoiceNumero = bestInvoice.numero_factura
          matchedClienteNombre = bestInvoice.cliente_nombre
          matchedSaldoPendiente = bestInvoice.saldo_pendiente
          candidates = entry.invoices
          mensajeRespuesta = bestInvoice.cliente_nombre ? `Confirmado. Pago de ${formatMonto(entry.total)} registrado para ${bestInvoice.cliente_nombre} — Factura ${bestInvoice.numero_factura}.` : `Confirmado. Pago de ${formatMonto(entry.total)} registrado para la factura ${bestInvoice.numero_factura}.`
        }
      } else {
        matchStatus = 'multi_invoice'
        candidates = entry.invoices
        mensajeRespuesta = formatMultiInvoiceMessage(entry.invoices, input.monto, entry.clientName)
      }
    } else if (candidatePool.length > 1) {
      matchStatus = 'ambiguous'
      candidates = candidatePool.flatMap(e => e.invoices)
      const lineas = candidatePool.map((e, i) => e.type === 'single' ? `${String.fromCharCode(65 + i)}. ${e.clientName} — Factura ${e.invoices[0].numero_factura} — Saldo: ${formatMonto(e.total)}` : `${String.fromCharCode(65 + i)}. ${e.clientName} — Suma de ${e.invoices.length} facturas: ${formatMonto(e.total)}`)
      mensajeRespuesta = `Recibimos un pago de ${formatMonto(input.monto ?? candidatePool[0].total)}. ${candidatePool.length} opciones posibles:\n\n` + lineas.join('\n') + '\n\nRespondé con la letra de la opción (A, B, C...).'
    }

    debugInfo.decision = { poolSize: candidatePool.length, entries: candidatePool.map(e => ({ type: e.type, clientName: e.clientName, total: e.total, invoiceCount: e.invoices.length })), finalStatus: matchStatus }
    debugInfo.final = { matchStatus, matchedInvoiceId, matchedInvoiceNumero, matchedClienteNombre, matchedSaldoPendiente, errorMessage }
    bestDest = allDestinationCandidates.length > 0 ? allDestinationCandidates.reduce((a, b) => a.score >= b.score ? a : b) : null
    if (bestDest) debugInfo.final_destination = { entity_type: bestDest.entity_type, entity_id: bestDest.entity_id, entity_name: bestDest.entity_name, match_field: bestDest.match_field, score: bestDest.score }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    errorMessage = `DryRun: ${msg}`
    matchStatus = 'no_match'
    mensajeRespuesta = 'No pudimos procesar el comprobante en modo prueba.'
  }

  return { matchStatus, candidates, matchedInvoiceId, matchedInvoiceNumero, matchedClienteNombre, matchedSaldoPendiente, bestDestination: bestDest, mensajeRespuesta, debugInfo, errorMessage }
}
