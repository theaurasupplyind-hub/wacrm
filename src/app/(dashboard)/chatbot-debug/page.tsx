'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { Bug, RefreshCw, Search, Code, ChevronDown, ChevronUp } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'

interface LogEntry {
  id: number
  created_at: string
  phone: string
  message_text: string | null
  step: string
  data: Record<string, unknown> | null
  duration_ms: number | null
  account_id: string
}

const STEP_LABELS: Record<string, { label: string; color: string }> = {
  intent_detected: { label: 'Intent', color: 'bg-blue-500/10 text-blue-400 border-blue-500/30' },
  suggest_price: { label: 'Suggest Price', color: 'bg-purple-500/10 text-purple-400 border-purple-500/30' },
  direct_response: { label: 'Direct Response', color: 'bg-green-500/10 text-green-400 border-green-500/30' },
  response_sent: { label: 'Response Sent', color: 'bg-green-500/10 text-green-400 border-green-500/30' },
  openrouter_response: { label: 'OpenRouter', color: 'bg-amber-500/10 text-amber-400 border-amber-500/30' },
  no_data: { label: 'No Data', color: 'bg-gray-500/10 text-gray-400 border-gray-500/30' },
  error: { label: 'Error', color: 'bg-red-500/10 text-red-400 border-red-500/30' },
}

export default function ChatbotDebugPage() {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [phoneFilter, setPhoneFilter] = useState('')
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchLogs = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: '100' })
      if (phoneFilter) params.set('phone', phoneFilter)
      const res = await fetch(`/api/chatbot/logs?${params}`)
      const data = await res.json()

      if (data.error && data.hint) {
        setError(data.error)
        return
      }

      if (data.error) {
        setError(data.error)
        return
      }

      setError(null)
      setLogs(data.records ?? [])
      setTotal(data.total ?? 0)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error fetching logs')
    } finally {
      setLoading(false)
    }
  }, [phoneFilter])

  useEffect(() => {
    fetchLogs()
  }, [fetchLogs])

  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(fetchLogs, 3000)
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [autoRefresh, fetchLogs])

  const toggleExpand = (id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const stepMeta = (step: string) => STEP_LABELS[step] ?? { label: step, color: 'bg-muted text-muted-foreground border-border' }

  const formatTime = (iso: string) => {
    try {
      const d = new Date(iso)
      return d.toLocaleString('es-AR', {
        month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      })
    } catch {
      return iso
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <Bug className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Chatbot Debug
        </h1>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Observá en tiempo real qué hace el chatbot cuando llega un mensaje.
        Los logs se actualizan cada 3 segundos.
      </p>

      <div className="mt-4 flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Teléfono (últimos dígitos)..."
            value={phoneFilter}
            onChange={(e) => setPhoneFilter(e.target.value)}
            className="pl-9"
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setAutoRefresh(!autoRefresh)}
        >
          <RefreshCw className={`mr-1.5 h-4 w-4 ${autoRefresh ? 'text-green-400' : ''}`} />
          {autoRefresh ? 'Auto' : 'Manual'}
        </Button>
        <Button variant="outline" size="sm" onClick={fetchLogs} disabled={loading}>
          <RefreshCw className="mr-1.5 h-4 w-4" />
          Refresh
        </Button>
      </div>

      <div className="mt-2 text-xs text-muted-foreground">
        {total} registros totales
      </div>

      {error && (
        <Card className="mt-4 border-amber-500/30 bg-amber-500/5">
          <CardContent className="py-3">
            <p className="text-sm text-amber-400">{error}</p>
          </CardContent>
        </Card>
      )}

      <div className="mt-4 space-y-2">
        {loading && logs.length === 0 && (
          <Card className="border-border bg-card">
            <CardContent className="flex items-center justify-center py-12">
              <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
            </CardContent>
          </Card>
        )}

        {!loading && !error && logs.length === 0 && (
          <Card className="border-border bg-card">
            <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Bug className="h-8 w-8 mb-2 opacity-50" />
              <p className="text-sm">No hay logs todavía.</p>
              <p className="text-xs mt-1">Mandá un mensaje por WhatsApp y los pasos del chatbot aparecerán acá.</p>
            </CardContent>
          </Card>
        )}

        {logs.map((log) => {
          const meta = stepMeta(log.step)
          const isExpanded = expandedIds.has(log.id)
          const isError = log.step === 'error'

          return (
            <Card
              key={log.id}
              className={`border transition-colors ${
                isError
                  ? 'border-red-500/20 bg-red-500/5'
                  : log.step === 'direct_response'
                    ? 'border-green-500/20 bg-card'
                    : log.step === 'openrouter_response'
                      ? 'border-amber-500/20 bg-card'
                      : 'border-border bg-card'
              }`}
            >
              <div
                className="flex items-start gap-3 px-4 py-3 cursor-pointer"
                onClick={() => toggleExpand(log.id)}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-mono text-muted-foreground whitespace-nowrap">
                      {formatTime(log.created_at)}
                    </span>
                    <Badge variant="outline" className={`text-[10px] ${meta.color}`}>
                      {meta.label}
                    </Badge>
                    {log.phone && (
                      <span className="text-xs text-muted-foreground font-mono">
                        +{log.phone}
                      </span>
                    )}
                    {log.duration_ms != null && (
                      <span className="text-[10px] text-muted-foreground">
                        {log.duration_ms}ms
                      </span>
                    )}
                  </div>
                  {log.message_text && (
                    <p className="mt-1 text-sm text-foreground truncate max-w-2xl">
                      {log.message_text}
                    </p>
                  )}
                  {!isExpanded && log.data && (
                    <p className="mt-0.5 text-xs text-muted-foreground truncate max-w-2xl">
                      {JSON.stringify(log.data).slice(0, 100)}
                    </p>
                  )}
                </div>
                <div className="shrink-0 pt-0.5">
                  {isExpanded ? (
                    <ChevronUp className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  )}
                </div>
              </div>

              {isExpanded && log.data && (
                <div className="border-t border-border px-4 py-3">
                  <div className="flex items-center gap-1.5 mb-2">
                    <Code className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Payload
                    </span>
                  </div>
                  <pre className="text-xs bg-muted rounded-lg p-3 overflow-x-auto font-mono text-muted-foreground whitespace-pre-wrap">
                    {JSON.stringify(log.data, null, 2)}
                  </pre>
                </div>
              )}
            </Card>
          )
        })}
      </div>
    </div>
  )
}
