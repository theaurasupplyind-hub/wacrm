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
  matchVoucherByName,
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
  const t0 = Date.now()
  const logs: VoiceOrderLog[] = []
  const isRolloQ = /rollo/i.test(q)
  const medidaQRaw = (q.match(/(\d+(?:[.,]\d+)?)\s*(?:[xX×]|por)\s*(\d+(?:[.,]\d+)?)/)?.[0] || '').replace(/\s/g,'').toLowerCase().replace(',','.')
  const isRollo2x5 = isRolloQ && (medidaQRaw === '2x5' || medidaQRaw === '2.0x5')
  const hasRolloMedida = isRolloQ && !!medidaQRaw
  // Si es rollo con medida !=2x5, no buscar en precios_referencia: preguntar precio
  if (isRolloQ && hasRolloMedida && !isRollo2x5) {
    const medidaSolicitada = medidaQRaw
    const data = [{
      medida_solicitada: medidaSolicitada,
      medida_referencia: null,
      categoria: 'ROLLO DE TELA',
      variante: '',
      precio: null,
      precio_base: null,
      faltante: false,
      necesita_precio: true,
      regla: null,
      descripcion: `ROLLO DE TELA ${medidaSolicitada} (solo 2x5 tiene precio $180.000 — ¿a qué precio?)`,
    }]
    return { data, log: { tool: `preciosReferencia(${q.slice(0,40)})`, duration_ms: Date.now() - t0, resultCount: 1 } }
  }
  // Si es consulta de rollo sin medida ("que medidas tienes"), mostrar solo 2x5
  if (isRolloQ && !hasRolloMedida && /medida|tienes|tienen|disponible/i.test(q)) {
    try {
      const direct = await suggestPrice('ROLLO DE TELA 2x5')
      const sug = direct.items?.[0] || direct.detalles?.[0]
      if (sug && sug.precio != null) {
        const data = [{
          medida_solicitada: '2x5',
          medida_referencia: direct.medida_encontrada || '2x5',
          categoria: 'ROLLO DE TELA',
          variante: sug.variante || '',
          precio: sug.precio,
          precio_base: sug.precio,
          faltante: false,
          regla: null,
          descripcion: `ROLLO DE TELA 2x5 — $180.000 (única medida con precio)`,
        }]
        return { data, log: { tool: `preciosReferencia(${q.slice(0,40)})`, duration_ms: Date.now() - t0, resultCount: 1 } }
      }
    } catch { /* fallback */ }
  }
  // Genérico: cualquier producto en precios_referencia — suggestPrice directo sin parse restrictivo
  try {
    const direct = await suggestPrice(q.slice(0, 200))
    // Si direct trae sugerencias/items válidos, usarlos (genérico, mañana funciona para moldura X nueva)
    const hasData = (direct.items?.length || 0) > 0 || (direct.sugerencias?.length || 0) > 0 || (direct.detalles?.length || 0) > 0
    if (hasData) {
      const validCat = direct.items?.some(i => !i.faltante && i.precio != null) || direct.sugerencias?.some(s => s.precio != null)
      if (validCat) {
        // Filtrar rollo bastidor contaminación: si q es rollo y direct devolvió BASTIDOR, forzar rollo 2x5 o necesita_precio
        const returnedBastidorForRollo = isRolloQ && (direct.items?.[0]?.categoria?.toLowerCase() === 'bastidor' || direct.sugerencias?.[0]?.categoria?.toLowerCase() === 'bastidor')
        if (returnedBastidorForRollo && !isRollo2x5) {
          if (hasRolloMedida) {
            const data = [{
              medida_solicitada: medidaQRaw,
              medida_referencia: null,
              categoria: 'ROLLO DE TELA',
              variante: '',
              precio: null,
              precio_base: null,
              faltante: false,
              necesita_precio: true,
              regla: null,
              descripcion: `ROLLO DE TELA ${medidaQRaw} (solo 2x5 tiene precio — ¿a qué precio?)`,
            }]
            return { data, log: { tool: `preciosReferencia(${q.slice(0,40)})`, duration_ms: Date.now() - t0, resultCount: 1 } }
          }
        } else {
          const data = (direct.items || direct.sugerencias || []).slice(0, 5).map((s: { categoria?: string; variante?: string; medida?: string; precio?: number | null; faltante?: boolean }) => ({
            medida_solicitada: s.medida || medidaQRaw || '',
            medida_referencia: direct.medida_encontrada || s.medida || '',
            categoria: s.categoria || '',
            variante: s.variante || '',
            precio: s.precio ?? null,
            precio_base: s.precio ?? null,
            faltante: s.faltante ?? (s.precio == null),
            regla: (direct as { regla_aplicada?: string | null }).regla_aplicada ?? null,
            descripcion: `${s.categoria || ''} ${s.medida || ''}${s.variante ? ` ${s.variante}` : ''}`.trim(),
          }))
          if (data.length > 0) {
            return { data, log: { tool: `preciosReferencia(${q.slice(0,40)})`, duration_ms: Date.now() - t0, resultCount: data.length } }
          }
        }
      }
    }
  } catch { /* cae a parse pipeline */ }

  // Fallback: pipeline parseOrder → resolveItems → priceItems (multi-item, variantes, grosor)
  try {
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      necesita_precio: (p as any).necesita_precio || (resolved.find(r => r.medida === p.medida_solicitada)?.necesita_precio) || false,
      descripcion: `${p.categoria} ${p.medida_solicitada}${p.variante ? ` ${p.variante}` : ''}`,
    }))
    // Si algún resolved tiene necesita_precio (rollo otra medida), asegurar flag
    for (const r of resolved) {
      if (r.necesita_precio) {
        const match = (data as { medida_solicitada: string; necesita_precio?: boolean }[]).find(d => d.medida_solicitada === r.medida)
        if (match) match.necesita_precio = true
        else data.push({
          medida_solicitada: r.medida,
          medida_referencia: null,
          categoria: r.categoria,
          variante: r.variante,
          precio: null,
          precio_base: null,
          faltante: false,
          necesita_precio: true,
          regla: null,
          descripcion: `${r.categoria} ${r.medida} (solo 2x5 tiene precio — ¿a qué precio?)`,
        } as never)
      }
    }
    return { data, log: { tool: `preciosReferencia(${q.slice(0,40)})`, duration_ms: Date.now() - t0, resultCount: data.length } }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { data: null, log: { tool: `preciosReferencia(${q.slice(0,40)})`, duration_ms: Date.now() - t0, error: msg } }
  }
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
  historyText?: string | null
}): Promise<{ toolResults: Record<string, unknown>; toolLogs: ToolLog[] }> {
  const q = args.text.toLowerCase()
  const pending: Promise<{ key: string; data: unknown; log: ToolLog }>[] = []

  function extractDebtFollowUp(hist: string | null | undefined, current: string): string | null {
    if (!hist) return null
    const recent = hist.slice(-1500).toLowerCase()
    const hadDebtAsk = /cu[aá]nto debe|cuanto debe|deuda de un cliente|revisar la deuda|saldo pendiente/i.test(recent)
    if (!hadDebtAsk) return null
    const t = current.trim()
    if (!t) return null
    if (/^(hola|gracias|si|no|dale|ok|chau)$/i.test(t)) return null
    if (/^[a-zA-Z]\s*$/.test(t) || /^[a-zA-Z](\s*,\s*[a-zA-Z])+$/.test(t)) return null
    // 1-2 palabras nombre propio 3-40 chars
    if (/^[A-Za-zÁÉÍÓÚáéíóúÑñ]{2,}(?:\s+[A-Za-zÁÉÍÓÚáéíóúÑñ]{2,})?$/.test(t) && t.length >= 3 && t.length <= 40) {
      console.log('[debt-followup] detected follow-up name="%s" from history debt ask', t)
      return t
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
  const needsProducts = args.intent === 'pedido' || q.includes('bastidor') || q.includes('presupuesto') || q.includes('precio') || q.includes('tapacanto') || q.includes('pintura') || q.includes('rollo') || q.includes(' x ') || /\d+\s*x\s*\d+/i.test(q)
  const isDebtQuery = args.intent === 'factura' || /cu[aá]nto debe|saldo pendiente|deuda de/i.test(args.text)
  const followUpDebtName = extractDebtFollowUp(args.historyText, args.text)
  const isDebtQueryEffective = isDebtQuery || !!followUpDebtName
  const debtClientName = (args.proveedor?.trim() || followUpDebtName || (() => {
    const m = args.text.match(/cu[aá]nto debe\s+(?:el\s+cliente\s+)?(.+?)(?:\?|$)/i)
    if (m) {
      const cand = m[1].trim()
      if (cand && !/un cliente/i.test(cand) && cand.length >= 3) return cand
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

  if (needsProducts) {
    const prodQ = args.text.slice(0, 200)
    // Single call, publicar en ambas keys para compat
    const preciosPromise = fetchPreciosReferencia(prodQ)
    pending.push(preciosPromise.then((r) => ({ key: 'precios_referencia', data: r.data, log: r.log })))
    pending.push(preciosPromise.then((r) => ({ key: 'products', data: r.data, log: { ...r.log, tool: r.log.tool.replace('preciosReferencia','products') } })))
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
