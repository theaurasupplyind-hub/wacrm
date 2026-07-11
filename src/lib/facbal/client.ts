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

export interface Producto {
  id: string
  descripcion: string
  precio_unitario: number
  categoria: string
  medida: string
  variante: string
  stock: number
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

export async function buscarProductos(
  query: string,
): Promise<Producto[]> {
  const base = `${apiUrl()}/products/search`
  const url = query ? `${base}?q=${encodeURIComponent(query)}` : `${base}?limit=30`

  const res = await fetch(url, {
    headers: { ...apiKeyHeader() },
    signal: AbortSignal.timeout(10_000),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(
      `FacBal API error ${res.status} al buscar productos${detail ? `: ${detail}` : ''}`,
    )
  }

  const data = await res.json()
  if (!Array.isArray(data)) {
    throw new Error('FacBal API devolvió una respuesta inesperada.')
  }

  return data as Producto[]
}

export interface SugerenciaPrecio {
  categoria: string
  medida: string
  variante: string
  precio: number
}

export interface OrderItem {
  cantidad: number
  categoria: string
  medida: string
  variante: string
  precio: number | null
  faltante: boolean
}

export interface DetallePrecio {
  cantidad: number
  categoria: string
  variante: string
  medida_solicitada: string
  medida_referencia: string
  precio: number | null
  faltante: boolean
}

export interface SuggestPriceResult {
  query: string
  medida_encontrada: string | null
  sugerencias: SugerenciaPrecio[]
  regla_aplicada: string | null
  mensaje: string | null
  items: OrderItem[]
  detalles: DetallePrecio[]
}

export async function suggestPrice(
  query: string,
): Promise<SuggestPriceResult> {
  const url = `${apiUrl()}/products/suggest-price?q=${encodeURIComponent(query)}`

  const res = await fetch(url, {
    headers: { ...apiKeyHeader() },
    signal: AbortSignal.timeout(25_000),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(
      `FacBal API error ${res.status} al sugerir precio${detail ? `: ${detail}` : ''}`,
    )
  }

  return res.json() as Promise<SuggestPriceResult>
}

export interface BulkPriceItem {
  categoria: string
  medida: string
  variante?: string | null
  cantidad: number
  regla?: string | null
}

export interface BulkPriceResultItem {
  cantidad: number
  categoria: string
  variante: string
  medida_solicitada: string
  medida_referencia: string
  precio: number | null
  faltante: boolean
}

export interface BulkPriceResult {
  items: BulkPriceResultItem[]
  sugerencias: SugerenciaPrecio[]
  mensaje: string | null
}

export async function bulkPrice(
  items: BulkPriceItem[],
  timeoutMs?: number,
): Promise<BulkPriceResult> {
  const url = `${apiUrl()}/products/bulk-price`

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...apiKeyHeader() },
    body: JSON.stringify({ items }),
    signal: AbortSignal.timeout(timeoutMs ?? 30_000),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(
      `FacBal API error ${res.status} en bulk price${detail ? `: ${detail}` : ''}`,
    )
  }

  return res.json() as Promise<BulkPriceResult>
}

export interface PriceListImageMeta {
  id: number
  name: string
  position: number
  created_at: string
}

export async function getPriceListImages(): Promise<PriceListImageMeta[]> {
  const url = `${apiUrl()}/price-list-images`

  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(
      `FacBal API error ${res.status} al listar imagenes${detail ? `: ${detail}` : ''}`,
    )
  }

  const data = await res.json()
  if (!Array.isArray(data)) {
    throw new Error('FacBal API devolvió una respuesta inesperada.')
  }

  return data as PriceListImageMeta[]
}

export function getPriceListImageUrl(imageId: number): string {
  return `${apiUrl()}/price-list-images/${imageId}/view`
}
