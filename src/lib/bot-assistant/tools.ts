import {
  listExpenses,
  searchProviders,
  listProviders,
  listEmployees,
  searchEmployees,
  getAttendance,
  listExpenseCategories,
  suggestPrice,
  bulkPrice,
} from '@/lib/facbal/client'
import { parseOrder } from '@/lib/voice-orders/parse-order'
import { resolveItems, priceItems } from '@/lib/voice-orders/execute-order'
import type { VoiceOrderLog } from '@/lib/voice-orders/types'

export type ToolLog = { tool: string; duration_ms: number; resultCount?: number; error?: string }

function todayISO(): string {
  const d = new Date()
  return d.toISOString().slice(0, 10)
}

function yesterdayISO(): string {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return d.toISOString().slice(0, 10)
}

async function withTiming<T>(tool: string, fn: () => Promise<T>): Promise<{ data: T | null; log: ToolLog; error?: string }> {
  const t0 = Date.now()
  try {
    const data = await fn()
    const count = Array.isArray(data) ? data.length : data != null ? 1 : 0
    return { data, log: { tool, duration_ms: Date.now() - t0, resultCount: count } }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { data: null, log: { tool, duration_ms: Date.now() - t0, error: msg }, error: msg }
  }
}

export async function fetchExpensesToday(): Promise<{ data: unknown; log: ToolLog }> {
  const { data, log } = await withTiming('listExpenses(today)', () =>
    listExpenses({ from_date: todayISO(), to_date: todayISO(), limit: 50 }),
  )
  return { data, log }
}

export async function fetchExpensesYesterday(): Promise<{ data: unknown; log: ToolLog }> {
  const { data, log } = await withTiming('listExpenses(yesterday)', () =>
    listExpenses({ from_date: yesterdayISO(), to_date: yesterdayISO(), limit: 50 }),
  )
  return { data, log }
}

export async function fetchProvidersByQuery(q: string): Promise<{ data: unknown; log: ToolLog }> {
  const { data, log } = await withTiming(`searchProviders(${q})`, () => searchProviders(q))
  return { data, log }
}

export async function fetchEmployeesByQuery(q: string): Promise<{ data: unknown; log: ToolLog }> {
  const { data, log } = await withTiming(`searchEmployees(${q})`, () => searchEmployees(q))
  return { data, log }
}

export async function fetchAllEmployees(): Promise<{ data: unknown; log: ToolLog }> {
  const { data, log } = await withTiming('listEmployees', () => listEmployees())
  return { data, log }
}

export async function fetchAllProviders(): Promise<{ data: unknown; log: ToolLog }> {
  const { data, log } = await withTiming('listProviders', () => listProviders())
  return { data, log }
}

export async function fetchAttendanceFor(employeeId: number, date: string): Promise<{ data: unknown; log: ToolLog }> {
  const { data, log } = await withTiming(`getAttendance(${employeeId},${date})`, () => getAttendance(employeeId, date))
  return { data, log }
}

export async function fetchCategories(): Promise<{ data: unknown; log: ToolLog }> {
  const { data, log } = await withTiming('listExpenseCategories', () => listExpenseCategories())
  return { data, log }
}

export async function fetchPreciosReferencia(q: string): Promise<{ data: unknown; log: ToolLog }> {
  // Solo precios_referencia vía suggestPrice/bulkPrice (tabla limpia), nunca productos sucia
  const logs: VoiceOrderLog[] = []
  const t0 = Date.now()
  try {
    // Parsear el texto como pedido para extraer items/entidades limpios
    const parsed = await parseOrder(q, '000', logs)
    if (!parsed.items.length) {
      return { data: [], log: { tool: `preciosReferencia(${q.slice(0,40)})`, duration_ms: Date.now() - t0, resultCount: 0 } }
    }
    const resolved = await resolveItems(parsed.items, logs, parsed.entidades)
    const pricing = await priceItems(resolved, logs)
    const data = pricing.items.map(p => ({
      medida_solicitada: p.medida_solicitada,
      medida_referencia: p.medida_referencia,
      categoria: p.categoria,
      variante: p.variante,
      precio: p.precio,
      precio_base: p.precio_base,
      faltante: p.faltante,
      regla: p.regla_aplicada,
      descripcion: `${p.categoria} ${p.medida_solicitada}${p.variante ? ` ${p.variante}` : ''}`,
    }))
    return { data, log: { tool: `preciosReferencia(${q.slice(0,40)})`, duration_ms: Date.now() - t0, resultCount: data.length } }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { data: null, log: { tool: `preciosReferencia(${q.slice(0,40)})`, duration_ms: Date.now() - t0, error: msg } }
  }
}

export async function fetchProducts(q: string): Promise<{ data: unknown; log: ToolLog }> {
  // deprecated: redirige a preciosReferencia para no usar productos sucia
  return fetchPreciosReferencia(q)
}

/**
 * Decide y ejecuta tools en paralelo según el texto/intent.
 * Retorna resultados crudos + logs.
 */
export async function runToolsForQuery(args: {
  text: string
  intent: string
  proveedor?: string | null
  empleado?: string | null
  fecha?: string | null
}): Promise<{ toolResults: Record<string, unknown>; toolLogs: ToolLog[] }> {
  const q = args.text.toLowerCase()
  const pending: Promise<{ key: string; data: unknown; log: ToolLog }>[] = []

  const needsExpenses =
    args.intent === 'gasto' ||
    args.intent === 'multi_expense' ||
    args.intent === 'factura' ||
    q.includes('gast') ||
    q.includes('cuanto') ||
    q.includes('cuánto') ||
    q.includes('cuándo') ||
    q.includes('cuando') ||
    q.includes('quien') ||
    q.includes('quién') ||
    q.includes('saldo') ||
    q.includes('debo') ||
    q.includes('proveedor') ||
    q.includes('hoy') ||
    q.includes('ayer')

  const needsAttendance =
    args.intent.startsWith('asistencia') ||
    q.includes('lleg') ||
    q.includes('falt') ||
    q.includes('asistencia') ||
    q.includes('ausente') ||
    q.includes('vacaciones') ||
    q.includes('licencia')

  const needsProviders = !!args.proveedor || q.includes('proveedor') || q.includes('debo a') || q.includes('pagué a') || q.includes('pague a')
  const needsEmployees = !!args.empleado || q.includes('empleado') || q.includes('sueldo')
  const needsProducts = args.intent === 'pedido' || q.includes('bastidor') || q.includes('presupuesto') || q.includes('precio') || q.includes('tapacanto') || q.includes('pintura') || q.includes('rollo') || q.includes(' x ') || /\d+\s*x\s*\d+/i.test(q)

  if (needsExpenses) {
    const isYesterday = q.includes('ayer')
    if (isYesterday) {
      pending.push(fetchExpensesYesterday().then((r) => ({ key: 'expenses', data: r.data, log: r.log })))
    } else {
      // por defecto hoy; si pide fecha explícita usa esa fecha (deja al responder interpretar)
      if (args.fecha) {
        pending.push(
          withTiming(`listExpenses(${args.fecha})`, () => listExpenses({ from_date: args.fecha!, to_date: args.fecha!, limit: 50 })).then((r) => ({
            key: 'expenses',
            data: r.data,
            log: r.log,
          })),
        )
      } else {
        pending.push(fetchExpensesToday().then((r) => ({ key: 'expenses', data: r.data, log: r.log })))
      }
    }
    // categorías ayudan a responder sin alucinar
    pending.push(fetchCategories().then((r) => ({ key: 'expense_categories', data: r.data, log: r.log })))
  }

  if (needsProviders) {
    if (args.proveedor) {
      pending.push(fetchProvidersByQuery(args.proveedor).then((r) => ({ key: 'providers', data: r.data, log: r.log })))
    } else if (q.includes('proveedor')) {
      pending.push(fetchAllProviders().then((r) => ({ key: 'providers', data: r.data, log: r.log })))
    }
  }

  if (needsEmployees || needsAttendance) {
    if (args.empleado) {
      pending.push(fetchEmployeesByQuery(args.empleado).then((r) => ({ key: 'employees', data: r.data, log: r.log })))
    } else if (needsEmployees) {
      pending.push(fetchAllEmployees().then((r) => ({ key: 'employees', data: r.data, log: r.log })))
    }
    // si es consulta de asistencia, necesitamos lista de empleados para luego getAttendance
    if (needsAttendance && !args.empleado) {
      pending.push(fetchAllEmployees().then((r) => ({ key: 'employees_for_attendance', data: r.data, log: r.log })))
    }
  }

  if (needsProducts) {
    // Producto limpio: precios_referencia + pricing_rules vía suggestPrice/bulkPrice
    const prodQ = args.text.slice(0, 120)
    pending.push(fetchPreciosReferencia(prodQ).then((r) => ({ key: 'precios_referencia', data: r.data, log: r.log })))
    // Mantener key legacy 'products' para prompts viejos, pero apuntando a limpia
    pending.push(fetchPreciosReferencia(prodQ).then((r) => ({ key: 'products', data: r.data, log: r.log })))
  }

  // Sin heurística => al menos intentar gastos hoy si es consulta factual genérica
  if (pending.length === 0 && (q.includes('cuanto') || q.includes('cuánto') || q.includes('debo') || q.includes('factura'))) {
    pending.push(fetchExpensesToday().then((r) => ({ key: 'expenses', data: r.data, log: r.log })))
  }

  if (pending.length === 0) {
    return { toolResults: {}, toolLogs: [] }
  }

  const settled = await Promise.all(pending)
  const toolResults: Record<string, unknown> = {}
  const toolLogs: ToolLog[] = []
  for (const s of settled) {
    toolResults[s.key] = s.data
    toolLogs.push(s.log)
  }

  // Si es consulta de asistencia "quién faltó ayer/hoy", expandir attendance por empleado (best-effort, limitado)
  if (needsAttendance && (q.includes('falt') || q.includes('quien') || q.includes('quién'))) {
    const employeesRaw = (toolResults['employees'] ?? toolResults['employees_for_attendance']) as unknown
    const list = Array.isArray(employeesRaw) ? (employeesRaw as { id: number; name: string }[]) : []
    const date = args.fecha || (q.includes('ayer') ? yesterdayISO() : todayISO())
    if (list.length > 0 && list.length <= 20) {
      const attendances = await Promise.all(
        list.slice(0, 12).map(async (emp) => {
          const { data, log } = await fetchAttendanceFor(emp.id, date)
          toolLogs.push(log)
          return { employee: emp.name, employee_id: emp.id, date, records: data }
        }),
      )
      toolResults['attendance'] = attendances
    }
  }

  return { toolResults, toolLogs }
}
