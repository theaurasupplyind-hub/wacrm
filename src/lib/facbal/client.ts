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
  precio_base: number | null
  regla_aplicada: string | null
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

// ─── Clientes ───

export interface FacbalClient {
  id: number
  nombre: string
  domicilio: string | null
  telefono: string | null
  taller: string | null
  estudiante: string | null
  lat: number | null
  lng: number | null
}

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function similarity(a: string, b: string): number {
  const na = normalizeText(a)
  const nb = normalizeText(b)
  if (na === nb) return 1
  if (na.includes(nb) || nb.includes(na)) return 0.8
  const tokensA = na.split(' ')
  const tokensB = nb.split(' ')
  const intersection = tokensA.filter(t => tokensB.includes(t)).length
  const union = new Set([...tokensA, ...tokensB]).size
  return union > 0 ? intersection / union : 0
}

export async function searchClients(
  nombre: string,
  telefono?: string,
): Promise<FacbalClient | null> {
  const url = `${apiUrl()}/clients`
  const res = await fetch(url, {
    headers: { ...apiKeyHeader() },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(
      `FacBal API error ${res.status} al buscar clientes${detail ? `: ${detail}` : ''}`,
    )
  }
  const data = await res.json() as FacbalClient[]
  if (!Array.isArray(data)) return null

  // Score all clients
  const scored = data.map(c => {
    let score = similarity(c.nombre, nombre)
    // Bonus for phone match
    if (telefono && c.telefono) {
      const cleanPhone = telefono.replace(/\D/g, '')
      const cleanCP = c.telefono.replace(/\D/g, '')
      if (cleanCP.includes(cleanPhone) || cleanPhone.includes(cleanCP)) {
        score += 0.3
      }
    }
    return { client: c, score }
  })

  scored.sort((a, b) => b.score - a.score)
  return scored.length > 0 && scored[0].score > 0.3 ? scored[0].client : null
}

export async function createClient(data: {
  nombre: string
  telefono?: string
  domicilio?: string
}): Promise<FacbalClient> {
  const url = `${apiUrl()}/clients`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...apiKeyHeader() },
    body: JSON.stringify({
      nombre: data.nombre,
      telefono: data.telefono || '',
      domicilio: data.domicilio || '',
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(
      `FacBal API error ${res.status} al crear cliente${detail ? `: ${detail}` : ''}`,
    )
  }
  return res.json() as Promise<FacbalClient>
}

// ─── Crear factura/presupuesto ───

export interface InvoiceCreatedResult {
  id: number
  numero_factura: string
  numero_presupuesto: string | null
  fecha: string
  cliente_nombre: string
  total: number
  tipo: string
}

export async function createInvoice(payload: {
  numero_factura: string
  numero_presupuesto?: string
  fecha: string
  cliente_id: number | null
  cliente_nombre: string
  cliente_domicilio?: string
  cliente_telefono?: string
  items: { cantidad: number; descripcion: string; precio_unitario: number; total: number }[]
  total: number
  envio: number
  tipo: string
  user_id: number
  tipo_entrega?: string
  fecha_entrega?: string
  estado_kanban?: string
}): Promise<InvoiceCreatedResult> {
  const url = `${apiUrl()}/invoices`

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...apiKeyHeader() },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(
      `FacBal API error ${res.status} al crear factura${detail ? `: ${detail}` : ''}`,
    )
  }

  return res.json() as Promise<InvoiceCreatedResult>
}
