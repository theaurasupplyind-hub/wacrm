export interface FacturaPendiente {
  invoice_id: number
  numero_factura: string
  cliente_nombre: string
  cliente_telefono: string
  total: number
  saldo_pendiente: number
  fecha: string
}

export interface PagoRegistrado {
  status: string
  id: number
}

function apiUrl(): string {
  const url = process.env.FACBAL_API_URL
  if (!url) {
    throw new Error(
      'FACBAL_API_URL is not set. Add it to your Vercel environment variables.',
    )
  }
  return url.replace(/\/$/, '')
}

function apiKeyHeader(): Record<string, string> {
  const key = process.env.FACBAL_API_KEY
  if (!key) {
    throw new Error(
      'FACBAL_API_KEY is not set. Add it to your Vercel environment variables.',
    )
  }
  return { 'X-API-Key': key }
}

export async function getFacturasPendientes(
  telefono: string,
): Promise<FacturaPendiente[]> {
  const url = `${apiUrl()}/invoices/pending-by-phone?telefono=${encodeURIComponent(telefono)}`

  const res = await fetch(url, {
    headers: { ...apiKeyHeader() },
    signal: AbortSignal.timeout(15_000),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(
      `FacBal API error ${res.status} al buscar facturas pendientes${detail ? `: ${detail}` : ''}`,
    )
  }

  const data = await res.json()
  if (!Array.isArray(data)) {
    throw new Error('FacBal API devolvió una respuesta inesperada.')
  }

  return data as FacturaPendiente[]
}

export async function registrarPago(args: {
  invoiceId: number
  monto: number
  fecha: string
}): Promise<PagoRegistrado> {
  const url = `${apiUrl()}/payments`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...apiKeyHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      invoice_id: args.invoiceId,
      amount: args.monto,
      date: args.fecha,
      method: 'Transferencia',
    }),
    signal: AbortSignal.timeout(15_000),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(
      `FacBal API error ${res.status} al registrar pago${detail ? `: ${detail}` : ''}`,
    )
  }

  return res.json() as Promise<PagoRegistrado>
}
