import { normalizeText as normalizeTextShared } from '@/lib/text/normalize'
import type { PrecioReferencia, PricingRule, RuleCondition } from '@/lib/precios/types'

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
  method?: string | null
  entityType?: string | null
  entityId?: number | null
}): Promise<PagoRegistrado> {
  const url = `${apiUrl()}/payments`
  const body: Record<string, unknown> = {
    invoice_id: args.invoiceId,
    amount: args.monto,
    date: args.fecha,
    method: args.method ?? 'Transferencia',
    user_id: 0,
  }
  if (args.entityType && args.entityId) {
    body.entity_type = args.entityType
    body.entity_id = args.entityId
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...apiKeyHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
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
  extracted_nombre_cliente?: string | null
  extracted_nombre_origen?: string | null
  extracted_nombre_destino?: string | null
  extracted_cbu_destino?: string | null
  extracted_cuit_destino?: string | null
  match_status: 'matched' | 'ambiguous' | 'no_match'
  matched_invoice_id?: number | null
  matched_invoice_numero?: string | null
  matched_cliente_nombre?: string | null
  matched_saldo_pendiente?: number | null
  entity_type?: string | null
  entity_id?: number | null
  entity_name?: string | null
  review_status?: string | null
  candidatas: VoucherCandidatePayload[]
  media_mime_type: string
  media_base64: string
}

export interface MatchVoucherCandidate {
  invoice_id: number
  numero_factura: string
  cliente_nombre: string
  cliente_telefono: string
  saldo_pendiente: number
  total: number
  fecha: string
  score: number
}

export interface DestinationCandidate {
  entity_type: 'PROVIDER' | 'EMPLOYEE'
  entity_id: number
  entity_name: string
  entity_cuit?: string
  entity_cbu?: string
  match_field: 'cbu' | 'cuit' | 'alias' | 'name'
  score: number
}

export interface MatchVoucherResult {
  invoice_candidates: MatchVoucherCandidate[]
  destination_candidates: DestinationCandidate[]
}

export async function matchVoucherByName(args: {
  nombre_cliente?: string | null
  nombre_origen?: string | null
  nombre_destino?: string | null
  cbu_destino?: string | null
  cuit_destino?: string | null
  monto?: number | null
  tolerancia?: number
  timeoutMs?: number
}): Promise<MatchVoucherResult> {
  const url = `${apiUrl()}/invoices/match-voucher`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...apiKeyHeader() },
    body: JSON.stringify({
      nombre_cliente: args.nombre_cliente ?? null,
      nombre_origen: args.nombre_origen ?? null,
      nombre_destino: args.nombre_destino ?? null,
      cbu_destino: args.cbu_destino ?? null,
      cuit_destino: args.cuit_destino ?? null,
      monto: args.monto ?? null,
      tolerancia: args.tolerancia ?? 50,
    }),
    signal: AbortSignal.timeout(args.timeoutMs ?? 20_000),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`FacBal API error ${res.status} en match-voucher${detail ? `: ${detail}` : ''}`)
  }
  return res.json() as Promise<MatchVoucherResult>
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

/**
 * @deprecated El endpoint `bulk-price` de backend_gal queda deprecado: no se
 * usa ni se mantiene. El flujo de pedidos usa el motor portado en `@/lib/precios`
 * (`suggestPrice`). No borrar (por compatibilidad), pero no generar código nuevo.
 */
export interface BulkPriceItem {
  categoria: string
  medida: string
  variante?: string | null
  cantidad: number
  regla?: string | null
}

/** @deprecated Ver {@link BulkPriceItem}. */
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

/** @deprecated Ver {@link BulkPriceItem}. */
export interface BulkPriceResult {
  items: BulkPriceResultItem[]
  sugerencias: SugerenciaPrecio[]
  mensaje: string | null
}

/** @deprecated Ver {@link BulkPriceItem}. */
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

// ─── Motor de precios local (galv2) ───
// Accesores de catálogo para el motor portado en `@/lib/precios`.

interface RawPricingRule {
  id?: number
  name?: string
  match_tokens?: string | string[] | null
  matchTokens?: string | string[] | null
  base_categoria?: string
  baseCategoria?: string
  base_variante?: string
  baseVariante?: string
  operation?: string
  operation_value?: number
  operationValue?: number
  conditions?: string | RuleCondition[] | null
  enabled?: boolean
  rounding?: number
}

function parseJsonArray<T>(value: string | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value || '[]')
      return Array.isArray(parsed) ? (parsed as T[]) : []
    } catch {
      return []
    }
  }
  return []
}

/**
 * Normaliza una fila de `pricing_rules` al tipo `PricingRule`. El backend
 * devuelve snake_case con `match_tokens` y `conditions` serializados como
 * JSON string (referencia: galv2 `Facturacion.svelte:585-604`). Acepta también
 * camelCase y arrays ya parseados por robustez.
 */
export function parsePricingRule(raw: RawPricingRule): PricingRule {
  return {
    id: raw.id,
    name: raw.name ?? '',
    matchTokens: parseJsonArray<string>(raw.matchTokens ?? raw.match_tokens),
    baseCategoria: raw.baseCategoria ?? raw.base_categoria ?? '',
    baseVariante: raw.baseVariante ?? raw.base_variante ?? '',
    operation: (raw.operation as PricingRule['operation']) ?? 'direct',
    operationValue: raw.operationValue ?? raw.operation_value ?? 0,
    conditions: parseJsonArray<RuleCondition>(raw.conditions),
    enabled: raw.enabled ?? true,
    rounding: raw.rounding ?? 1000,
  }
}

export async function getPreciosReferencia(): Promise<PrecioReferencia[]> {
  const url = `${apiUrl()}/precios-referencia`

  const res = await fetch(url, {
    headers: { ...apiKeyHeader() },
    signal: AbortSignal.timeout(15_000),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(
      `FacBal API error ${res.status} al obtener precios de referencia${detail ? `: ${detail}` : ''}`,
    )
  }

  const data = await res.json()
  if (!Array.isArray(data)) {
    throw new Error('FacBal API devolvió una respuesta inesperada.')
  }

  return data as PrecioReferencia[]
}

export async function getPricingRules(): Promise<PricingRule[]> {
  const url = `${apiUrl()}/pricing-rules`

  const res = await fetch(url, {
    headers: { ...apiKeyHeader() },
    signal: AbortSignal.timeout(15_000),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(
      `FacBal API error ${res.status} al obtener reglas de precios${detail ? `: ${detail}` : ''}`,
    )
  }

  const data = await res.json()
  if (!Array.isArray(data)) {
    throw new Error('FacBal API devolvió una respuesta inesperada.')
  }

  return (data as RawPricingRule[]).map(parsePricingRule)
}

export async function nextInvoiceNumber(prefix = 'F'): Promise<string> {
  const url = `${apiUrl()}/invoices/next_number?prefix=${encodeURIComponent(prefix)}`

  const res = await fetch(url, {
    headers: { ...apiKeyHeader() },
    signal: AbortSignal.timeout(15_000),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(
      `FacBal API error ${res.status} al obtener número de factura${detail ? `: ${detail}` : ''}`,
    )
  }

  const data = (await res.json()) as { next_number?: string }
  if (!data?.next_number) {
    throw new Error('FacBal API devolvió un número de factura inesperado.')
  }

  return data.next_number
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
  /** Último tipo de entrega elegido (galv2 lo restaura al elegir el cliente). */
  ultimo_tipo_entrega?: string | null
}

export interface ClientMatch {
  client: FacbalClient
  score: number
}

function normalizeText(s: string): string {
  return normalizeTextShared(s)
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
  const matches = await findClientMatches(nombre, telefono, { limit: 1, minScore: 0.3 })
  return matches[0]?.client ?? null
}

/**
 * Devuelve hasta `limit` clientes candidatos ordenados por score, con un piso
 * `minScore`. Se usa para *confirmar* con el usuario antes de vincular (evita
 * duplicados): el bot muestra el/los candidatos y el usuario elige.
 */
export async function findClientMatches(
  nombre: string,
  telefono?: string,
  opts: { limit?: number; minScore?: number } = {},
): Promise<ClientMatch[]> {
  const limit = opts.limit ?? 5
  const minScore = opts.minScore ?? 0.45
  const nombreTrim = (nombre || '').trim()
  if (!nombreTrim && !telefono) return []

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
  if (!Array.isArray(data)) return []

  const cleanPhone = (telefono || '').replace(/\D/g, '')
  const scored = data.map(c => {
    let score = nombreTrim ? similarity(c.nombre, nombreTrim) : 0
    // Bonus fuerte si el teléfono coincide (mismo número = mismo cliente).
    if (cleanPhone && c.telefono) {
      const cp = c.telefono.replace(/\D/g, '')
      if (cp && (cp.includes(cleanPhone) || cleanPhone.includes(cp))) score += 0.5
    }
    return { client: c, score }
  })

  return scored
    .filter(m => m.score > minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
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

export interface InvoiceItemDetail {
  id?: number
  cantidad: number
  descripcion: string
  precio_unitario: number
  total: number
}

export interface InvoiceDetail {
  id: number
  numero_factura: string | null
  numero_presupuesto: string | null
  fecha: string
  cliente_id: number | null
  cliente_nombre: string
  cliente_telefono: string | null
  cliente_domicilio: string | null
  items: InvoiceItemDetail[]
  total: number
  envio?: number | null
  tipo: string
  tipo_entrega: string | null
  estado_kanban: string | null
}

/** GET /invoices/{id}. Devuelve null si no existe (404). */
export async function getInvoice(id: number): Promise<InvoiceDetail | null> {
  const url = `${apiUrl()}/invoices/${id}`

  const res = await fetch(url, {
    headers: { ...apiKeyHeader() },
    signal: AbortSignal.timeout(15_000),
  })

  if (res.status === 404) return null
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(
      `FacBal API error ${res.status} al obtener factura${detail ? `: ${detail}` : ''}`,
    )
  }

  return res.json() as Promise<InvoiceDetail>
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
  mov_type?: 'PURCHASE' | 'PAYMENT'
  mode?: string
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
  entry_time?: string | null
  exit_time?: string | null
  late_threshold?: number
}

export interface AttendanceRecord {
  employee_id: number
  date: string
  status?: string
  exit_time?: string
}

export interface AttendanceRow {
  id: number
  employee_id: number
  date: string
  status: string | null
  exit_time: string | null
  created_at?: string
}

export async function createAttendance(
  record: AttendanceRecord,
): Promise<{ id: number } & AttendanceRecord> {
  const url = `${apiUrl()}/attendance`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...apiKeyHeader() },
    body: JSON.stringify(record),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(
      `FacBal API error ${res.status} al registrar asistencia${detail ? `: ${detail}` : ''}`,
    )
  }
  return res.json() as Promise<{ id: number } & AttendanceRecord>
}

export async function getAttendance(
  employeeId: number,
  date: string,
): Promise<AttendanceRow[]> {
  const url = `${apiUrl()}/attendance?employee_id=${employeeId}&date=${encodeURIComponent(date)}`
  const res = await fetch(url, {
    headers: { ...apiKeyHeader() },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(
      `FacBal API error ${res.status} al consultar asistencia${detail ? `: ${detail}` : ''}`,
    )
  }
  const data = await res.json()
  return Array.isArray(data) ? (data as AttendanceRow[]) : []
}

export async function listProviders(): Promise<Provider[]> {
  const url = `${apiUrl()}/providers`
  const res = await fetch(url, {
    headers: { ...apiKeyHeader() },
    signal: AbortSignal.timeout(30_000),
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
    signal: AbortSignal.timeout(25_000),
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
    signal: AbortSignal.timeout(30_000),
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

export async function getEmployee(id: number): Promise<Employee | null> {
  const url = `${apiUrl()}/employees/${id}`
  const res = await fetch(url, {
    headers: { ...apiKeyHeader() },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    if (res.status === 404) return null
    const detail = await res.text().catch(() => '')
    throw new Error(`FacBal API error ${res.status} al obtener empleado${detail ? `: ${detail}` : ''}`)
  }
  const data = await res.json()
  return (data?.employee ?? data) as Employee
}

export async function searchEmployees(q: string): Promise<Employee[]> {
  const url = `${apiUrl()}/employees/search?q=${encodeURIComponent(q)}`
  const res = await fetch(url, {
    headers: { ...apiKeyHeader() },
    signal: AbortSignal.timeout(25_000),
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
    signal: AbortSignal.timeout(30_000),
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
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(
      `FacBal API error ${res.status} al crear categoría${detail ? `: ${detail}` : ''}`,
    )
  }
  return res.json() as Promise<ExpenseCategory>
}

export interface ExpenseUpdatePayload {
  date?: string
  amount?: number
  description?: string
  category_id?: number
  provider_id?: number | null
  employee_id?: number | null
  payment_method?: string
  reference?: string
  status?: string
}

export async function updateExpense(
  expenseId: number,
  payload: ExpenseUpdatePayload,
): Promise<Expense> {
  const url = `${apiUrl()}/expenses/${expenseId}`
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...apiKeyHeader() },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(
      `FacBal API error ${res.status} al actualizar gasto${detail ? `: ${detail}` : ''}`,
    )
  }
  return res.json() as Promise<Expense>
}

export async function createExpense(
  payload: ExpenseCreatePayload,
): Promise<Expense> {
  const url = `${apiUrl()}/expenses`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...apiKeyHeader() },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
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
