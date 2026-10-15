/**
 * Vía de lectura del orquestador legacy (`runAssistant`).
 *
 * Fase 1 del plan agente-conversacional: las lecturas delegan a las queries
 * compartidas de `tool-registry.ts` (única fuente de verdad de QUÉ se
 * consulta). Acá solo queda el envelope legacy ({data, log} con withTiming y
 * los nombres de tool históricos) y el ruteo por keywords
 * (`runToolsForQuery`), que se jubila en Fase 4.
 */
import { getAttendance } from '@/lib/facbal/client'
import {
  queryFacturas,
  queryGastos,
  queryProveedores,
  queryEmpleados,
  queryCategorias,
  todayISO,
} from './tool-registry'

export type ToolLog = { tool: string; duration_ms: number; resultCount?: number; error?: string }

function yesterdayISO(): string {
  return todayISO(-1)
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
    queryGastos(todayISO(), todayISO()),
  )
  return { data, log }
}

export async function fetchExpensesYesterday(): Promise<{ data: unknown; log: ToolLog }> {
  const { data, log } = await withTiming('listExpenses(yesterday)', () =>
    queryGastos(yesterdayISO(), yesterdayISO()),
  )
  return { data, log }
}

export async function fetchProvidersByQuery(q: string): Promise<{ data: unknown; log: ToolLog }> {
  const { data, log } = await withTiming(`searchProviders(${q})`, () => queryProveedores(q))
  return { data, log }
}

export async function fetchEmployeesByQuery(q: string): Promise<{ data: unknown; log: ToolLog }> {
  const { data, log } = await withTiming(`searchEmployees(${q})`, () => queryEmpleados(q))
  return { data, log }
}

export async function fetchAllEmployees(): Promise<{ data: unknown; log: ToolLog }> {
  const { data, log } = await withTiming('listEmployees', () => queryEmpleados(null))
  return { data, log }
}

export async function fetchAllProviders(): Promise<{ data: unknown; log: ToolLog }> {
  const { data, log } = await withTiming('listProviders', () => queryProveedores(null))
  return { data, log }
}

export async function fetchAttendanceFor(employeeId: number, date: string): Promise<{ data: unknown; log: ToolLog }> {
  const { data, log } = await withTiming(`getAttendance(${employeeId},${date})`, () => getAttendance(employeeId, date))
  return { data, log }
}

export async function fetchCategories(): Promise<{ data: unknown; log: ToolLog }> {
  const { data, log } = await withTiming('listExpenseCategories', () => queryCategorias())
  return { data, log }
}

export async function fetchDebtByClient(clientName: string): Promise<{ data: unknown; log: ToolLog }> {
  return withTiming(`deuda_cliente(${clientName.slice(0,40)})`, () => queryFacturas(clientName))
}

export async function runToolsForQuery(args: {
  text: string
  intent: string
  proveedor?: string | null
  empleado?: string | null
  fecha?: string | null
  historyText?: string | null
}): Promise<{ toolResults: Record<string, unknown>; toolLogs: ToolLog[] }> {
  const q = args.text.toLowerCase()
  const pending: Promise<{ key: string; data: unknown; log: ToolLog }>[] = []

  function extractDebtFollowUp(hist: string | null | undefined, current: string): string | null {
    if (!hist) return null
    // No heredar para pregunta genérica "deuda de un cliente" (evita arrastrar Aldo Chiappe viejo)
    if (/deuda de un cliente|de un cliente\?/i.test(current)) {
      console.log('[debt] generic debt ask without name — not reusing history (current="%s")', current.slice(0, 60))
      return null
    }
    const recent = hist.slice(-1500).toLowerCase()
    const hadDebtAsk = /cu[aá]nto debe|cuanto debe|deuda de un cliente|revisar la deuda|saldo pendiente/i.test(recent)
    if (!hadDebtAsk) return null
    let t = current.trim()
    if (!t) return null
    // Permitir "De Aldo" => "Aldo"
    const deMatch = t.match(/^(?:de|del)\s+(.+)$/i)
    if (deMatch) t = deMatch[1].trim()
    if (/^(hola|gracias|si|no|dale|ok|chau)$/i.test(t)) return null
    if (/^[a-zA-Z]\s*$/.test(t) || /^[a-zA-Z](\s*,\s*[a-zA-Z])+$/.test(t)) return null
    // 1-2 palabras nombre propio 3-40 chars
    if (/^[A-Za-zÁÉÍÓÚáéíóúÑñ]{2,}(?:\s+[A-Za-zÁÉÍÓÚáéíóúÑñ]{2,})?$/.test(t) && t.length >= 3 && t.length <= 40) {
      console.log('[debt-followup] detected follow-up name="%s" from history debt ask', t)
      return t
    }
    return null
  }

  function extractConfirmedDebtName(hist: string | null | undefined, current: string): string | null {
    if (!hist) return null
    const t = current.trim().toLowerCase()
    if (!/^(si|sí|si es|correcto|dale|confirmo|si, es esa|si es esa)$/i.test(t)) return null
    // Buscar último "Me aparece "X". ¿Es esa la persona?" en historial
    const m = hist.match(/Me aparece\s+"([^"]+)"\.\s*¿Es esa la persona\?/i)
    if (m && m[1]) {
      const name = m[1].trim()
      console.log('[debt-followup] detected confirmed name="%s" from prior proposal', name)
      return name
    }
    return null
  }

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

  const NAME = '[A-Za-zÁÉÍÓÚáéíóúÑñ]{2,}'
  // "pagó carlitos", "carlitos pagó?", "tiene alguna factura", "facturas de X"
  const pagoQueryRe = new RegExp(`(?:^|\\b)pag[oó]\\s+(${NAME}(?:\\s+${NAME})?)\\??$|^(${NAME}(?:\\s+${NAME})?)\\s+pag[oó]\\??$`, 'i')
  const pagoMatch = args.text.trim().match(pagoQueryRe)
  const isDebtQuery =
    args.intent === 'factura' ||
    /cu[aá]nto debe|saldo pendiente|deuda de|deuda con|saldo con|se debe|debemos|le debo|le debemos|debo a|tiene (?:alguna )?factura|facturas (?:de|pendientes)|le queda/i.test(args.text) ||
    !!pagoMatch
  const confirmedDebtName = extractConfirmedDebtName(args.historyText, args.text)
  const followUpDebtName = confirmedDebtName || extractDebtFollowUp(args.historyText, args.text)
  const isDebtQueryEffective = isDebtQuery || !!followUpDebtName
  const debtClientName = (args.proveedor?.trim() || followUpDebtName || (() => {
    // "pagó <nombre>" / "<nombre> pagó?"
    const pagoName = (pagoMatch?.[1] || pagoMatch?.[2] || '').trim()
    if (pagoName && pagoName.length >= 3) return pagoName
    let m = args.text.match(/cu[aá]nto debe\s+(?:el\s+cliente\s+)?(.+?)(?:\?|$)/i)
    if (m) {
      const cand = m[1].trim()
      if (cand && !/un cliente/i.test(cand) && cand.length >= 3) return cand
    }
    m = args.text.match(/(?:deuda|saldo|facturas)\s+de\s+([A-Za-zÁÉÍÓÚáéíóúÑñ]{2,}(?:\s+[A-Za-zÁÉÍÓÚáéíóúÑñ]{2,})?)/i)
    if (m) {
      const cand = m[1].trim()
      if (cand && !/un cliente/i.test(cand) && cand.length >= 2) return cand
    }
    m = args.text.match(/(tiene alguna factura|tiene facturas?)\s+(?:de\s+|el\s+|la\s+)?([A-Za-zÁÉÍÓÚáéíóúÑñ]{2,}(?:\s+[A-Za-zÁÉÍÓÚáéíóúÑñ]{2,})?)/i)
    if (m) {
      const cand = (m[2] || '').trim()
      if (cand && cand.length >= 3) return cand
    }
    return null
  })())

  // Deuda con PROVEEDOR (plata que DEBEMOS nosotros): si el nombre de la deuda
  // matchea un proveedor conocido, NO se consulta como cliente (queryFacturas
  // trae facturas de clientes = nos deben a nosotros, dato invertido).
  // Se devuelve deuda_proveedor con el balance del proveedor.
  let supplierDebt: { name: string; providerName: string; balance: number | null } | null = null
  let providersPrefetch: { name: string; data: unknown; log: ToolLog } | null = null
  if (isDebtQueryEffective && debtClientName) {
    try {
      const r = await fetchProvidersByQuery(debtClientName)
      providersPrefetch = { name: debtClientName, data: r.data, log: r.log }
      const list = Array.isArray(r.data) ? (r.data as { name?: unknown; balance?: unknown }[]) : []
      const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      const target = norm(debtClientName)
      const hit = list.find(
        (p) =>
          p &&
          typeof p.name === 'string' &&
          (norm(p.name) === target || norm(p.name).includes(target) || (target.length >= 4 && target.includes(norm(p.name)))),
      )
      if (hit && typeof hit.name === 'string') {
        supplierDebt = {
          name: debtClientName,
          providerName: hit.name,
          balance: typeof hit.balance === 'number' ? hit.balance : null,
        }
        console.log('[debt] supplier debt detected name="%s" provider="%s" balance=%s — skipping deuda_cliente', debtClientName, hit.name, String(supplierDebt.balance))
      }
    } catch {
      // Si falla el chequeo, se sigue vía cliente como antes
    }
  }

  if (needsExpenses) {
    const isYesterday = q.includes('ayer')
    if (isYesterday) {
      pending.push(fetchExpensesYesterday().then((r) => ({ key: 'expenses', data: r.data, log: r.log })))
    } else {
      // por defecto hoy; si pide fecha explícita usa esa fecha (deja al responder interpretar)
      if (args.fecha) {
        pending.push(
          withTiming(`listExpenses(${args.fecha})`, () => queryGastos(args.fecha!, args.fecha!)).then((r) => ({
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
      if (providersPrefetch && providersPrefetch.name === args.proveedor.trim()) {
        const pre = providersPrefetch
        pending.push(Promise.resolve({ key: 'providers', data: pre.data, log: pre.log }))
      } else {
        pending.push(fetchProvidersByQuery(args.proveedor).then((r) => ({ key: 'providers', data: r.data, log: r.log })))
      }
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

  if (supplierDebt) {
    const sd = supplierDebt
    pending.push(
      Promise.resolve({
        key: 'deuda_proveedor',
        data: sd,
        log: { tool: `deuda_proveedor(${sd.name.slice(0, 40)})`, duration_ms: 0, resultCount: 1 },
      }),
    )
  } else if (isDebtQueryEffective && debtClientName) {
    // timeout 5min via historial: si followUp viene de historial viejo >10 turns no se detecta (history slice -10)
    console.log('[debt] dispatch deuda_cliente client="%s" via %s', debtClientName, followUpDebtName ? 'followUp' : 'direct')
    pending.push(fetchDebtByClient(debtClientName).then((r) => {
      if (r.log.error) console.error('[debt] fetchDebtByClient failed client=%s error=%s', debtClientName, r.log.error)
      else console.log('[debt] fetchDebtByClient OK client=%s invoices=%s total=%s', debtClientName, (r.data as { invoices?: unknown[] })?.invoices?.length ?? 0, (r.data as { total?: number })?.total)
      return { key: 'deuda_cliente', data: r.data, log: r.log }
    }))
  } else if (isDebtQueryEffective && !debtClientName) {
    console.log('[debt] deuda query without client name — will ask for name (no tool)')
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
    if (s.log.error) {
      console.error('[tools] %s failed: %s', s.log.tool, s.log.error)
    } else {
      console.log('[tools] %s OK resultCount=%s duration=%sms', s.log.tool, s.log.resultCount ?? 0, s.log.duration_ms)
    }
  }
  // Timeout log: si parecía follow-up de deuda pero no se disparó por falta de historial reciente
  if (!debtClientName && !followUpDebtName && args.historyText && /cu[aá]nto debe|deuda de un cliente|revisar la deuda/i.test(args.historyText.slice(-800).toLowerCase()) && /^[A-Za-zÁÉÍÓÚáéíóúÑñ]{3,}(?:\s+[A-Za-zÁÉÍÓÚáéíóúÑñ]{2,})?$/.test(args.text.trim()) ) {
    console.warn('[debt] follow-up name="%s" ignored — deuda ask fuera de ventana 5min/10turns (hist slice)', args.text.trim())
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
