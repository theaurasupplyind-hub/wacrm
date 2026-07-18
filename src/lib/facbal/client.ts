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

export interface VoucherCandidatePayload {
  invoice_id: number
  numero_factura: string
  saldo_pendiente: number
  cliente_nombre?: string | null
  fecha?: string | null
}

export interface VoucherReviewCreatePayload {
  source_message_id?: string | null
  wa_id: string
  contact_name?: string | null
  extracted_monto?: number | null
  extracted_fecha?: string | null
  extracted_referencia?: string | null
  extracted_banco?: string | null
  match_status: 'matched' | 'ambiguous' | 'no_match'
  matched_invoice_id?: number | null
  matched_invoice_numero?: string | null
  matched_cliente_nombre?: string | null
  matched_saldo_pendiente?: number | null
  candidatas: VoucherCandidatePayload[]
  media_mime_type: string
  media_base64: string
}

export async function createVoucherReview(
  payload: VoucherReviewCreatePayload,
): Promise<{ status: string; id: number }> {
  const url = `${apiUrl()}/voucher-reviews`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...apiKeyHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(40_000),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(
      `FacBal API error ${res.status} al crear voucher review${detail ? `: ${detail}` : ''}`,
    )
  }

  return res.json() as Promise<{ status: string; id: number }>
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

// ─── Gastos ───

export interface ExpenseCategory {
  id: number
  name: string
  slug: string
  color: string
  icon: string
  type: string
  is_default: number
  created_by: number | null
  created_at: string
}

export interface Expense {
  id: number
  date: string
  amount: number
  description: string
  category_id: number
  provider_id: number | null
  employee_id: number | null
  payment_method: string
  reference: string | null
  source: string
  created_by_user_id: number | null
  created_by_contact_id: number | null
  status: string
  raw_input: string | null
  media_url: string | null
  media_id: string | null
  created_at: string
  updated_at: string
}

export interface PaymentSplit {
  amount: number
  payment_method: string
}

export interface ExpenseCreatePayload {
  date: string
  amount: number
  description: string
  category_id: number
  provider_id?: number | null
  employee_id?: number | null
  payment_method?: string
  payments?: PaymentSplit[]
  reference?: string
  source?: string
  created_by_user_id?: number | null
  created_by_contact_id?: number | null
  status?: string
  raw_input?: string | null
  media_url?: string | null
  media_id?: string | null
}

export interface Provider {
  id: number
  name: string
  cuit?: string | null
  alias_mp?: string | null
  alias_cbu?: string | null
  address?: string | null
  balance: number
  stock_qty: number
}

export interface Employee {
  id: number
  name: string
  phone?: string | null
  address?: string | null
  active: number
  job_type: string
  base_salary: number
}

export async function listProviders(): Promise<Provider[]> {
  const url = `${apiUrl()}/providers`
  const res = await fetch(url, {
    headers: { ...apiKeyHeader() },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(
      `FacBal API error ${res.status} al listar proveedores${detail ? `: ${detail}` : ''}`,
    )
  }
  const data = await res.json()
  return Array.isArray(data) ? (data as Provider[]) : []
}

export async function searchProviders(q: string): Promise<Provider[]> {
  const url = `${apiUrl()}/providers/search?q=${encodeURIComponent(q)}`
  const res = await fetch(url, {
    headers: { ...apiKeyHeader() },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(
      `FacBal API error ${res.status} al buscar proveedores${detail ? `: ${detail}` : ''}`,
    )
  }
  const data = await res.json()
  return Array.isArray(data) ? (data as Provider[]) : []
}

export async function listEmployees(): Promise<Employee[]> {
  const url = `${apiUrl()}/employees`
  const res = await fetch(url, {
    headers: { ...apiKeyHeader() },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(
      `FacBal API error ${res.status} al listar empleados${detail ? `: ${detail}` : ''}`,
    )
  }
  const data = await res.json()
  return Array.isArray(data) ? (data as Employee[]) : []
}

export async function searchEmployees(q: string): Promise<Employee[]> {
  const url = `${apiUrl()}/employees/search?q=${encodeURIComponent(q)}`
  const res = await fetch(url, {
    headers: { ...apiKeyHeader() },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(
      `FacBal API error ${res.status} al buscar empleados${detail ? `: ${detail}` : ''}`,
    )
  }
  const data = await res.json()
  return Array.isArray(data) ? (data as Employee[]) : []
}

export async function listExpenseCategories(): Promise<ExpenseCategory[]> {
  const url = `${apiUrl()}/expense-categories`
  const res = await fetch(url, {
    headers: { ...apiKeyHeader() },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(
      `FacBal API error ${res.status} al listar categorías${detail ? `: ${detail}` : ''}`,
    )
  }
  const data = await res.json()
  return Array.isArray(data) ? (data as ExpenseCategory[]) : []
}

export async function createExpenseCategory(
  payload: Omit<ExpenseCategory, 'id' | 'created_at'>,
): Promise<ExpenseCategory> {
  const url = `${apiUrl()}/expense-categories`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...apiKeyHeader() },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(
      `FacBal API error ${res.status} al crear categoría${detail ? `: ${detail}` : ''}`,
    )
  }
  return res.json() as Promise<ExpenseCategory>
}

export async function createExpense(
  payload: ExpenseCreatePayload,
): Promise<Expense> {
  const url = `${apiUrl()}/expenses`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...apiKeyHeader() },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(
      `FacBal API error ${res.status} al crear gasto${detail ? `: ${detail}` : ''}`,
    )
  }
  return res.json() as Promise<Expense>
}

export async function listExpenses(params?: {
  from_date?: string
  to_date?: string
  category_id?: number
  provider_id?: number
  employee_id?: number
  source?: string
  status?: string
  limit?: number
}): Promise<Expense[]> {
  const q = new URLSearchParams()
  if (params?.from_date) q.set('from_date', params.from_date)
  if (params?.to_date) q.set('to_date', params.to_date)
  if (params?.category_id) q.set('category_id', String(params.category_id))
  if (params?.provider_id) q.set('provider_id', String(params.provider_id))
  if (params?.employee_id) q.set('employee_id', String(params.employee_id))
  if (params?.source) q.set('source', params.source)
  if (params?.status) q.set('status', params.status)
  if (params?.limit) q.set('limit', String(params.limit))
  const qs = q.toString()
  const url = `${apiUrl()}/expenses${qs ? '?' + qs : ''}`
  const res = await fetch(url, {
    headers: { ...apiKeyHeader() },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(
      `FacBal API error ${res.status} al listar gastos${detail ? `: ${detail}` : ''}`,
    )
  }
  const data = await res.json()
  return Array.isArray(data) ? (data as Expense[]) : []
}

export async function migrateExpenses(): Promise<{ status: string; created: number }> {
  const url = `${apiUrl()}/expenses/migrate`
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...apiKeyHeader() },
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(
      `FacBal API error ${res.status} al migrar gastos${detail ? `: ${detail}` : ''}`,
    )
  }
  return res.json() as Promise<{ status: string; created: number }>
}

// ─── Fin del archivo ───
