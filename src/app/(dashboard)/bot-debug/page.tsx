'use client'

import { useEffect, useState } from 'react'
import {
  Search,
  ChevronDown,
  ChevronRight,
  Bug,
  MessageSquare,
  Wallet,
  Clock,
  Check,
  X,
  AlertTriangle,
  HelpCircle,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'

type LogType = 'router' | 'expense' | 'attendance'

interface RouterLog {
  id: number
  message_id: string | null
  raw_text: string | null
  flow_consumed: boolean
  interactive: boolean
  had_context: boolean
  extractor_source: string | null
  intent: string | null
  confianza: string | null
  dudoso: boolean
  faltan_campos: string[] | null
  dispatched_to: string | null
  dispatch_reason: string | null
  debug_info: { context_text?: string | null; extraction?: unknown } | null
  error_message: string | null
  created_at: string
}

interface ExpenseLog {
  id: string
  message_id: string | null
  raw_text: string | null
  extracted_amount: number | null
  extracted_category: string | null
  extracted_provider: string | null
  extracted_employee: string | null
  extracted_payment_method: string | null
  match_status: string | null
  matched_expense_id: number | null
  error_message: string | null
  extractor_source: string | null
  confianza: string | null
  debug_info: unknown
  created_at: string
}

interface AttendanceLog {
  id: number
  message_id: string | null
  raw_text: string | null
  intent: string | null
  extractor_source: string | null
  employee_name: string | null
  time: string | null
  date: string | null
  status_type: string | null
  faltan_campos: string[] | null
  outcome: string | null
  matched_employee_id: number | null
  matched_employee_name: string | null
  error_message: string | null
  debug_info: unknown
  created_at: string
}

type AnyLog = RouterLog | ExpenseLog | AttendanceLog

const TABS: { id: LogType; label: string; icon: typeof MessageSquare }[] = [
  { id: 'router', label: 'Router', icon: MessageSquare },
  { id: 'expense', label: 'Gastos', icon: Wallet },
  { id: 'attendance', label: 'Asistencia', icon: Clock },
]

const GOOD = new Set([
  'confirmed', 'recorded', 'correction_recorded', 'matched', 'llm',
  'voucher', 'voice', 'flow', 'interactive', 'intent',
])
const BAD = new Set([
  'error', 'cancelled', 'rejected_no_arrival', 'employee_not_found',
])
const WARN = new Set([
  'ambiguous', 'collecting', 'ask_employee', 'ask_time', 'awaiting_correction',
  'pending', 'none', 'fallback', 'fallback_regex', 'otro', 'baja', 'media',
])

function statusVariant(status: string | null | undefined): 'default' | 'secondary' | 'destructive' | 'outline' {
  const s = status || ''
  if (GOOD.has(s)) return 'default'
  if (BAD.has(s)) return 'destructive'
  if (WARN.has(s)) return 'secondary'
  return 'outline'
}

function statusIcon(status: string | null | undefined) {
  const s = status || ''
  if (GOOD.has(s)) return <Check className="h-3 w-3" />
  if (BAD.has(s)) return <X className="h-3 w-3" />
  if (WARN.has(s)) return <AlertTriangle className="h-3 w-3" />
  return <HelpCircle className="h-3 w-3" />
}

function RowBadge({ status }: { status: string | null | undefined }) {
  return (
    <Badge variant={statusVariant(status)} className="inline-flex items-center gap-1">
      {statusIcon(status)}
      {status || '—'}
    </Badge>
  )
}

function Field({ label, value }: { label: string; value: string | null | undefined | number | boolean }) {
  if (value === null || value === undefined || value === '') return null
  return (
    <div>
      <span className="text-muted-foreground">{label}: </span>
      <span className="font-medium">{String(value)}</span>
    </div>
  )
}

function DetailBlock({ title, value }: { title: string; value: unknown }) {
  const [open, setOpen] = useState(false)
  if (value === null || value === undefined) return null
  return (
    <div className="border rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium hover:bg-muted/50 bg-muted/30"
      >
        <span>{title}</span>
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </button>
      {open && (
        <pre className="px-3 py-2 text-[11px] text-muted-foreground overflow-auto max-h-80 whitespace-pre-wrap">
          {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  )
}

function RouterDetail({ row }: { row: RouterLog }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
      <Field label="Intent" value={row.intent} />
      <Field label="Confianza" value={row.confianza} />
      <Field label="Extractor" value={row.extractor_source} />
      <Field label="Contexto" value={row.had_context ? 'sí' : 'no'} />
      <Field label="Flow consumed" value={row.flow_consumed ? 'sí' : 'no'} />
      <Field label="Interactive" value={row.interactive ? 'sí' : 'no'} />
      <Field label="Dudoso" value={row.dudoso ? 'sí' : 'no'} />
      <Field label="Faltan campos" value={row.faltan_campos?.join(', ')} />
      {row.dispatch_reason && <Field label="Razón" value={row.dispatch_reason} />}
      {row.debug_info?.context_text && (
        <div className="col-span-2 md:col-span-4">
          <DetailBlock title="Contexto enviado al LLM" value={row.debug_info.context_text} />
        </div>
      )}
      {row.debug_info?.extraction != null && (
        <div className="col-span-2 md:col-span-4">
          <DetailBlock title="Extracción (debug)" value={row.debug_info.extraction} />
        </div>
      )}
    </div>
  )
}

function ExpenseDetail({ row }: { row: ExpenseLog }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
      <Field label="Monto" value={row.extracted_amount !== null ? `$${Number(row.extracted_amount).toFixed(2)}` : null} />
      <Field label="Categoría" value={row.extracted_category} />
      <Field label="Proveedor" value={row.extracted_provider} />
      <Field label="Empleado" value={row.extracted_employee} />
      <Field label="Método" value={row.extracted_payment_method} />
      <Field label="Extractor" value={row.extractor_source} />
      <Field label="Confianza" value={row.confianza} />
      <Field label="Expense ID" value={row.matched_expense_id} />
      {row.error_message && (
        <div className="col-span-2 md:col-span-4 bg-destructive/10 text-destructive text-sm px-3 py-2 rounded-lg">
          Error: {row.error_message}
        </div>
      )}
      {row.debug_info != null && (
        <div className="col-span-2 md:col-span-4">
          <DetailBlock title="Detalle (debug)" value={row.debug_info} />
        </div>
      )}
    </div>
  )
}

function AttendanceDetail({ row }: { row: AttendanceLog }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
      <Field label="Intent" value={row.intent} />
      <Field label="Empleado" value={row.employee_name} />
      <Field label="Hora" value={row.time} />
      <Field label="Fecha" value={row.date} />
      <Field label="Estado" value={row.status_type} />
      <Field label="Extractor" value={row.extractor_source} />
      <Field label="Empleado ID" value={row.matched_employee_id} />
      <Field label="Faltan campos" value={row.faltan_campos?.join(', ')} />
      {row.error_message && (
        <div className="col-span-2 md:col-span-4 bg-destructive/10 text-destructive text-sm px-3 py-2 rounded-lg">
          Error: {row.error_message}
        </div>
      )}
      {row.debug_info != null && (
        <div className="col-span-2 md:col-span-4">
          <DetailBlock title="Detalle (debug)" value={row.debug_info} />
        </div>
      )}
    </div>
  )
}

function LogRow({ row, type }: { row: AnyLog; type: LogType }) {
  const [open, setOpen] = useState(false)
  const createdAt = row.created_at

  let primary: string | null = null
  let secondary: string | null = null
  let tertiary: string | null = null
  let body: string | null = null
  let bodyText = ''

  if (type === 'router') {
    const r = row as RouterLog
    primary = r.dispatched_to || 'none'
    secondary = r.intent
    tertiary = r.confianza || null
    body = r.raw_text
    bodyText = `intent=${secondary || '—'} confianza=${tertiary || '—'} source=${r.extractor_source || '—'}`
  } else if (type === 'expense') {
    const r = row as ExpenseLog
    primary = r.match_status || 'pending'
    secondary = r.extracted_category
    tertiary = r.extracted_amount !== null ? `$${Number(r.extracted_amount).toFixed(2)}` : null
    body = r.raw_text
    bodyText = `categoría=${secondary || '—'} monto=${tertiary || '—'} source=${r.extractor_source || '—'}`
  } else {
    const r = row as AttendanceLog
    primary = r.outcome || 'not_handled'
    secondary = r.employee_name
    tertiary = r.time
    body = r.raw_text
    bodyText = `empleado=${secondary || '—'} hora=${tertiary || '—'} intent=${r.intent || '—'}`
  }

  return (
    <div className="border rounded-xl bg-card overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-muted/30"
      >
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <RowBadge status={primary} />
          <span className="font-medium truncate text-sm">{secondary || '—'}</span>
          {tertiary && <span className="text-muted-foreground truncate text-sm">{tertiary}</span>}
          {body && <span className="text-muted-foreground truncate text-sm hidden md:inline flex-1">{body}</span>}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-muted-foreground text-xs">
            {new Date(createdAt).toLocaleString('es-AR')}
          </span>
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </div>
      </button>

      {open && (
        <div className="border-t px-4 py-4 space-y-3">
          <div className="text-xs text-muted-foreground">{bodyText}</div>
          {body && (
            <div className="bg-muted/40 rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words">
              {body}
            </div>
          )}
          {type === 'router' && <RouterDetail row={row as RouterLog} />}
          {type === 'expense' && <ExpenseDetail row={row as ExpenseLog} />}
          {type === 'attendance' && <AttendanceDetail row={row as AttendanceLog} />}
          <div className="text-xs text-muted-foreground">
            <span>Message ID: </span>
            <code className="bg-muted px-1 py-0.5 rounded">
              {type === 'expense'
                ? (row as ExpenseLog).message_id
                : type === 'attendance'
                  ? (row as AttendanceLog).message_id
                  : (row as RouterLog).message_id || '—'}
            </code>
          </div>
        </div>
      )}
    </div>
  )
}

export default function BotDebugPage() {
  const [activeTab, setActiveTab] = useState<LogType>('router')
  const [data, setData] = useState<{
    tab: LogType
    records: AnyLog[]
    error: string | null
  }>({ tab: 'router', records: [], error: null })

  useEffect(() => {
    let cancelled = false
    fetch(`/api/bot-logs?type=${activeTab}`)
      .then((res) => res.json())
      .then((json) => {
        if (cancelled) return
        if (json.error) {
          setData({ tab: activeTab, records: [], error: json.error })
        } else {
          setData({ tab: activeTab, records: json.records || [], error: null })
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setData({ tab: activeTab, records: [], error: err.message })
        }
      })
    return () => {
      cancelled = true
    }
  }, [activeTab])

  // True mientras la pestaña activa todavía no tiene datos cargados.
  const loading = data.tab !== activeTab
  const error = data.error
  const records = data.records

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Bot Debug</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Logs del router de intents, gastos y asistencia
          </p>
        </div>
      </div>

      <div className="flex gap-1 border-b">
        {TABS.map((tab) => {
          const Icon = tab.icon
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                activeTab === tab.id
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </button>
          )
        })}
      </div>

      {loading && (
        <div className="flex items-center justify-center py-24 text-muted-foreground">
          Cargando...
        </div>
      )}

      {!loading && error && (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <Bug className="h-12 w-12 text-destructive/40 mb-4" />
          <h2 className="text-lg font-medium">Error al cargar</h2>
          <p className="mt-2 text-sm text-muted-foreground max-w-md">{error}</p>
        </div>
      )}

      {!loading && !error && records.length === 0 && (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <Search className="h-12 w-12 text-muted-foreground/40 mb-4" />
          <h2 className="text-lg font-medium">Sin datos</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Enviá un mensaje de prueba para ver la decisión del router aquí.
          </p>
        </div>
      )}

      {!loading && !error && (
        <div className="space-y-3">
          {records.map((row, i) => (
            <LogRow
              key={`${activeTab}-${'id' in row ? String(row.id) : i}-${row.created_at}`}
              row={row}
              type={activeTab}
            />
          ))}
        </div>
      )}
    </div>
  )
}
