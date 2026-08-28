import { NextRequest, NextResponse } from 'next/server'
import { extractVoucherData } from '@/lib/ai/voucher-extraction'
import { extractBotMessage } from '@/lib/bot-llm/extract-bot-message'
import { runVoucherDryRun } from '@/lib/bot-beta/voucher-dryrun'

export const maxDuration = 60

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get('content-type') || ''

    // Texto efectivo: "Tobi pagó $12.000 en efectivo" (sin imagen)
    if (contentType.includes('application/json')) {
      const body = (await req.json()) as { text?: string; phone?: string }
      const text = (body.text || '').trim()
      if (!text) return NextResponse.json({ error: 'Texto requerido' }, { status: 400 })

      // Reusa extractor unificado para sacar cliente/monto/metodo
      const ext = await extractBotMessage(text)
      // Gate: "Le pagamos a X por sueldo" es gasto (egreso), no voucher de factura (ingreso)
      if (ext.intent === 'gasto' && ext.empleado_gasto) {
        return NextResponse.json({
          mode: 'text',
          dryRun: true,
          wouldWrite: false,
          extraction: ext,
          matchStatus: 'no_match',
          candidates: [],
          mensajeRespuesta: `Intent=gasto (sueldo a ${ext.empleado_gasto}) — no es voucher de factura. Usá el tab Asistente para registrar sueldos.`,
          banner: '🔒 Simulación — no es voucher (es gasto)',
          debugInfo: { gate: 'gasto_sueldo_no_voucher' },
        })
      }
      const monto = ext.monto
      let nombreCliente: string | null = ext.proveedor || ext.empleado || ext.empleado_gasto || null
      // Fallback: texto corto sin verbo ("Delio", "Isabela", "Mathiaz Delio") → usar texto raw como nombre a buscar
      if (!nombreCliente && (ext.intent === 'otro' || ext.confianza === 'baja')) {
        const rawWords = text.trim().split(/\s+/).filter(Boolean)
        const isShortName = rawWords.length >= 1 && rawWords.length <= 3 && !/\d/.test(text) && rawWords.every(w => /^[a-zA-ZáéíóúÁÉÍÓÚñÑ]+$/.test(w))
        if (isShortName) {
          const cleaned = text.trim().replace(/[^a-zA-ZáéíóúÁÉÍÓÚñÑ\s]/g, ' ').replace(/\s+/g, ' ').trim()
          if (cleaned.length >= 2) nombreCliente = cleaned
        }
      }
      // Nombre origen/cliente para matching
      const dry = await runVoucherDryRun({
        monto: monto ?? null,
        fecha: ext.fecha ?? null,
        referencia: null,
        banco: ext.metodo_pago ?? null,
        nombre_cliente: nombreCliente,
        nombre_origen: nombreCliente,
        nombre_destino: null,
        cbu_destino: null,
        cuit_destino: null,
      })

      return NextResponse.json({
        mode: 'text',
        dryRun: true,
        wouldWrite: false,
        extraction: ext,
        monto,
        clienteDetectado: nombreCliente,
        ...dry,
        banner: '🔒 Simulación — no se escribió en backend_gal (dryRun copy)',
      })
    }

    // Imagen/PDF: FormData{file}
    const formData = await req.formData()
    const file = formData.get('file') as File | null
    const textFallback = (formData.get('text') as string) || ''
    if (!file || !(file instanceof File)) {
      // Permitir solo texto via FormData también
      if (textFallback.trim()) {
        const ext = await extractBotMessage(textFallback)
        if (ext.intent === 'gasto' && ext.empleado_gasto) {
          return NextResponse.json({ mode: 'text', dryRun: true, wouldWrite: false, extraction: ext, matchStatus: 'no_match', candidates: [], mensajeRespuesta: `Intent=gasto (sueldo a ${ext.empleado_gasto}) — no es voucher. Usá Asistente.`, banner: '🔒 No voucher', debugInfo: { gate: 'gasto' } })
        }
        let nombreCliente2: string | null = ext.proveedor || ext.empleado || ext.empleado_gasto || null
        if (!nombreCliente2 && (ext.intent === 'otro' || ext.confianza === 'baja')) {
          const rawWords = textFallback.trim().split(/\s+/).filter(Boolean)
          const isShortName = rawWords.length >= 1 && rawWords.length <= 3 && !/\d/.test(textFallback) && rawWords.every(w => /^[a-zA-ZáéíóúÁÉÍÓÚñÑ]+$/.test(w))
          if (isShortName) {
            const cleaned = textFallback.trim().replace(/[^a-zA-ZáéíóúÁÉÍÓÚñÑ\s]/g, ' ').replace(/\s+/g, ' ').trim()
            if (cleaned.length >= 2) nombreCliente2 = cleaned
          }
        }
        const dry = await runVoucherDryRun({
          monto: ext.monto ?? null,
          fecha: ext.fecha ?? null,
          referencia: null,
          banco: ext.metodo_pago ?? null,
          nombre_cliente: nombreCliente2,
          nombre_origen: nombreCliente2,
          nombre_destino: null,
          cbu_destino: null,
          cuit_destino: null,
        })
        return NextResponse.json({ mode: 'text', dryRun: true, wouldWrite: false, extraction: ext, ...dry, banner: '🔒 Simulación — no se escribió en backend_gal' })
      }
      return NextResponse.json({ error: 'Archivo requerido (image/* o .pdf) o texto' }, { status: 400 })
    }

    const bytes = Buffer.from(await file.arrayBuffer())
    const base64 = bytes.toString('base64')
    const mimeType = file.type || 'application/octet-stream'

    const voucher = await extractVoucherData({ base64, mimeType })

    const dry = await runVoucherDryRun({
      monto: voucher.monto ?? null,
      fecha: voucher.fecha ?? null,
      referencia: voucher.referencia ?? null,
      banco: voucher.banco ?? null,
      nombre_cliente: voucher.nombre_cliente ?? null,
      nombre_origen: voucher.nombre_origen ?? null,
      nombre_destino: voucher.nombre_destino ?? null,
      cbu_destino: voucher.cbu_destino ?? null,
      cuit_destino: voucher.cuit_destino ?? null,
    })

    return NextResponse.json({
      mode: 'file',
      dryRun: true,
      wouldWrite: false,
      extraction: voucher,
      fileName: file.name,
      mimeType,
      ...dry,
      banner: '🔒 Simulación — no se escribió en backend_gal ni en voucher_reviews (copia aislada)',
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
