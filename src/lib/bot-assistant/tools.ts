import {
  listExpenses,
  searchProviders,
  listProviders,
  listEmployees,
  searchEmployees,
  getAttendance,
  listExpenseCategories,
  matchVoucherByName,
} from '@/lib/facbal/client'

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

export async function fetchDebtByClient(clientName: string): Promise<{ data: unknown; log: ToolLog }> {
  return withTiming(`deuda_cliente(${clientName.slice(0,40)})`, async () => {
    const res = await matchVoucherByName({
      nombre_cliente: clientName,
      nombre_origen: clientName,
      nombre_destino: null,
      cbu_destino: null,
      cuit_destino: null,
      monto: 0,
      tolerancia: 999999999,
    })
    const invoices = (res.invoice_candidates || []).map((c) => ({
      factura: c.numero_factura,
      cliente: c.cliente_nombre,
      saldo: c.saldo_pendiente,
      fecha: c.fecha,
      score: c.score,
    }))
    const total = invoices.reduce((s, i) => s + (i.saldo || 0), 0)
    return { invoices: invoices.slice(0, 10), total, cliente_buscado: clientName }
  })
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
    // fallback: última propuesta con comillas
    const m2 = hist.match(/"([^"]+Chiappe[^"]*)"/i)
    if (m2 && m2[1]) return m2[1].trim()
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
    /cu[aá]nto debe|saldo pendiente|deuda de|tiene (?:alguna )?factura|facturas (?:de|pendientes)|le queda/i.test(args.text) ||
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

  if (isDebtQueryEffective && debtClientName) {
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
