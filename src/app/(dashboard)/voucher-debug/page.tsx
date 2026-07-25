'use client'

import { useEffect, useState } from 'react'
import { Search, Check, X, AlertTriangle, ChevronDown, ChevronRight, Bug, Users, ArrowRight, RotateCcw, DollarSign } from 'lucide-react'
import { Badge } from '@/components/ui/badge'

interface CandidateInfo {
  factura: string
  cliente: string
  saldo: number
  score?: number
  dist?: number
}

interface StepInfo {
  step: string
  input: CandidateInfo[]
  filters?: Record<string, unknown>
  disambiguation?: Record<string, unknown>
  result: { status: string; matchedInvoiceId?: number | null }
}

interface PhaseInfo {
  apiCall: Record<string, unknown>
  apiResult: CandidateInfo[]
  steps?: StepInfo[]
  result: { status: string; matchedInvoiceId: number | null }
}

interface Extraction {
  id: number
  message_id: string
  extracted_amount: number | null
  extracted_date: string | null
  extracted_reference: string | null
  extracted_bank: string | null
  match_status: string
  matched_invoice_id: number | null
  error_message: string | null
  created_at: string
  debug_info: {
    phase1: PhaseInfo | null
    phase2: PhaseInfo | null
    phase3: { candidatesShown: number; candidates: CandidateInfo[] } | null
    final: {
      matchStatus: string
      matchedInvoiceId: number | null
      matchedInvoiceNumero: string | null
      matchedClienteNombre: string | null
      matchedSaldoPendiente: number | null
      errorMessage: string | null
    } | null
  } | null
}

function StatusBadge({ status, small }: { status: string; small?: boolean }) {
  const variant = status === 'matched' || status === 'multi_invoice' ? 'default' : status === 'ambiguous' ? 'secondary' : 'destructive'
  const icon = status === 'matched' ? <Check className={small ? 'h-2.5 w-2.5' : 'h-3 w-3'} /> : status === 'multi_invoice' ? <Users className={small ? 'h-2.5 w-2.5' : 'h-3 w-3'} /> : status === 'ambiguous' ? <AlertTriangle className={small ? 'h-2.5 w-2.5' : 'h-3 w-3'} /> : <X className={small ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
  return (
    <Badge variant={variant} className={`inline-flex items-center gap-1 ${small ? 'text-[10px] h-4 px-1.5' : ''}`}>
      {icon}
      {status}
    </Badge>
  )
}

function CandidateTable({ candidates, showScore, showDist }: { candidates: CandidateInfo[]; showScore?: boolean; showDist?: boolean }) {
  if (candidates.length === 0) return <p className="text-xs text-muted-foreground">Sin candidatos</p>
  return (
    <table className="w-full text-xs border-collapse">
      <thead>
        <tr className="border-b text-muted-foreground">
          <th className="py-1 pr-2 text-left w-24">Factura</th>
          <th className="py-1 pr-2 text-left">Cliente</th>
          <th className="py-1 pr-2 text-right w-20">Saldo</th>
          {showDist && <th className="py-1 pr-2 text-right w-14">Dist</th>}
          {showScore && <th className="py-1 text-right w-18">Score</th>}
        </tr>
      </thead>
      <tbody>
        {candidates.map((c, i) => (
          <tr key={i} className="border-b border-muted/50">
            <td className="py-1 pr-2 font-mono">{c.factura}</td>
            <td className="py-1 pr-2">{c.cliente}</td>
            <td className="py-1 pr-2 text-right">${c.saldo.toFixed(2)}</td>
            {showDist && <td className="py-1 pr-2 text-right font-mono">{c.dist?.toFixed(2)}</td>}
            {showScore && <td className="py-1 text-right font-mono">{c.score?.toFixed(4)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function StepIcon({ step }: { step: string }) {
  if (step === 'Exact match') return <DollarSign className="h-3.5 w-3.5 text-blue-500" />
  if (step === 'Exact sum') return <DollarSign className="h-3.5 w-3.5 text-green-500" />
  if (step === 'Close match') return <Users className="h-3.5 w-3.5 text-amber-500" />
  return <ArrowRight className="h-3.5 w-3.5" />
}

function StepBlock({ step }: { step: StepInfo }) {
  const [open, setOpen] = useState(false)
  const status = step.result?.status || 'unknown'
  const resolved = status === 'matched' || status === 'multi_invoice'

  return (
    <div className={`border rounded-lg overflow-hidden ${resolved ? 'border-green-200 dark:border-green-900' : ''}`}>
      <button
        onClick={() => setOpen(!open)}
        className={`flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium hover:bg-muted/50 ${resolved ? 'bg-green-50 dark:bg-green-950/20' : 'bg-muted/30'}`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <StepIcon step={step.step} />
          <span className="truncate">{step.step}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {status === 'multi_invoice' && <span className="text-[10px] text-green-600">✓ Resuelto</span>}
          {status === 'matched' && <span className="text-[10px] text-green-600">✓ Matched</span>}
          {status === 'no_match' && !resolved && <span className="text-[10px] text-muted-foreground">Sin match →</span>}
          {resolved && !open && <ChevronRight className="h-3 w-3" />}
          {open && <ChevronDown className="h-3 w-3" />}
        </div>
      </button>

      {open && (
        <div className="px-3 py-2 space-y-2 text-xs">
          <div>
            <span className="font-medium text-muted-foreground">Input ({step.input.length} candidates):</span>
            <CandidateTable candidates={step.input} showScore />
          </div>

          {!!step.filters?.byMonto && (
            <div>
              <span className="font-medium text-muted-foreground">
                Filter: {String((step.filters.byMonto as Record<string, unknown>).rule || 'byMonto')}
              </span>
              <span className="text-muted-foreground ml-1">
                ({Number((step.filters.byMonto as Record<string, unknown>).passedCount) || 0} of {Number((step.filters.byMonto as Record<string, unknown>).total) || 0} passed)
              </span>
              <CandidateTable candidates={(step.filters.byMonto as Record<string, unknown>).passed as CandidateInfo[]} showDist showScore />
            </div>
          )}

          {!!step.filters?.groupBy && (
            <div>
              <span className="font-medium text-muted-foreground">
                Group: {String(step.filters.groupBy)} — {String(step.filters.operator)}
              </span>
              {!!step.filters.tolerance && <span className="text-muted-foreground"> (tolerance {String(step.filters.tolerance)})</span>}
              {!!((step.result as Record<string, unknown>).groups) && ((step.result as Record<string, unknown>).groups as { clientName: string; total: number; invoices: { factura: string; saldo: number }[] }[]).map((g, i) => (
                <div key={i} className="mt-1 p-2 rounded bg-muted/30">
                  <div className="font-medium mb-1">{g.clientName} — Total: ${g.total.toFixed(2)}</div>
                  {g.invoices.map((inv, j) => (
                    <div key={j} className="text-muted-foreground pl-3 text-[11px]">
                      {inv.factura}: ${inv.saldo.toFixed(2)}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {step.disambiguation && (
            <div>
              <span className="font-medium text-muted-foreground">Disambiguation:</span>
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 mt-0.5 text-muted-foreground">
                {Object.entries(step.disambiguation).map(([key, val]) => {
                  let display = typeof val === 'boolean' ? (val ? '✓' : '✗') : String(val ?? '')
                  if (display === '[object Object]') display = JSON.stringify(val)
                  return (
                    <div key={key} className="flex items-center gap-1">
                      <span className="text-[11px]">{key}:</span>
                      <span className="font-mono text-[11px] truncate max-w-[120px]">{display}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          <div className={`pt-1 border-t text-xs font-medium ${resolved ? 'text-green-600' : status === 'no_match' ? 'text-muted-foreground' : 'text-amber-600'}`}>
            Result: {status}
            {step.result?.matchedInvoiceId && <span> (invoice #{step.result.matchedInvoiceId})</span>}
          </div>
        </div>
      )}
    </div>
  )
}

function PhaseTimeline({ phase, label }: { phase: PhaseInfo | null; label: string }) {
  const [open, setOpen] = useState(false)
  if (!phase) return null

  const hasSteps = phase.steps && phase.steps.length > 0
  const resolved = phase.result?.status === 'matched' || phase.result?.status === 'multi_invoice'

  return (
    <div className="border rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className={`flex w-full items-center justify-between px-4 py-3 text-left text-sm hover:bg-muted/30 ${resolved ? 'bg-green-50/50 dark:bg-green-950/10' : ''}`}
      >
        <div className="flex items-center gap-3">
          <span className="font-medium">{label}</span>
          {hasSteps && <span className="text-xs text-muted-foreground">({phase.steps!.length} steps)</span>}
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={phase.result?.status || 'unknown'} />
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </div>
      </button>

      {open && (
        <div className="border-t px-4 py-3 space-y-3 text-sm">
          <div>
            <span className="text-xs text-muted-foreground">API Call:</span>{' '}
            <code className="text-[11px] bg-muted px-1.5 py-0.5 rounded">{JSON.stringify(phase.apiCall)}</code>
          </div>

          {phase.apiResult.length > 0 && (
            <div>
              <span className="text-xs text-muted-foreground">API Result ({phase.apiResult.length} candidates):</span>
              <CandidateTable candidates={phase.apiResult} showScore />
            </div>
          )}

          {hasSteps && (
            <div>
              <span className="text-xs text-muted-foreground mb-2 block">Steps:</span>
              <div className="space-y-1.5 relative ml-1 pl-4 border-l-2 border-muted-foreground/20">
                {phase.steps!.map((s, i) => (
                  <div key={i} className="relative">
                    <StepBlock step={s} />
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className={`text-xs font-medium pt-1 border-t ${resolved ? 'text-green-600' : 'text-muted-foreground'}`}>
            Final: {phase.result?.status}
            {phase.result?.matchedInvoiceId && <span> (invoice #{phase.result.matchedInvoiceId})</span>}
          </div>
        </div>
      )}
    </div>
  )
}

export default function VoucherDebugPage() {
  const [extractions, setExtractions] = useState<Extraction[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<number | null>(null)

  useEffect(() => {
    fetch('/api/voucher/logs')
      .then((res) => res.json())
      .then((data) => {
        if (data.error) {
          setError(data.error)
        } else {
          setExtractions(data.records || [])
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return <div className="flex items-center justify-center py-24 text-muted-foreground">Cargando...</div>
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Bug className="h-12 w-12 text-destructive/40 mb-4" />
        <h1 className="text-xl font-bold">Error al cargar</h1>
        <p className="mt-2 text-sm text-muted-foreground max-w-md">{error}</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Voucher Debug</h1>
          <p className="text-sm text-muted-foreground mt-1">{extractions.length} extractions registradas</p>
        </div>
      </div>

      {extractions.length === 0 && (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <Search className="h-12 w-12 text-muted-foreground/40 mb-4" />
          <h2 className="text-lg font-medium">Sin datos</h2>
          <p className="text-sm text-muted-foreground mt-1">Enviá un comprobante de pago para ver el proceso aquí.</p>
        </div>
      )}

      <div className="space-y-4">
        {extractions.map((ext) => (
          <div key={ext.id} className="border rounded-xl bg-card overflow-hidden">
            <button
              onClick={() => setExpandedId(expandedId === ext.id ? null : ext.id)}
              className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-muted/30"
            >
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <StatusBadge status={ext.match_status} />
                <span className="font-medium truncate">
                  {ext.extracted_amount !== null ? `$${Number(ext.extracted_amount).toFixed(2)}` : '?'}
                </span>
                {ext.extracted_reference && (
                  <span className="text-muted-foreground truncate text-sm">{ext.extracted_reference}</span>
                )}
                <span className="text-muted-foreground text-xs shrink-0">
                  {new Date(ext.created_at).toLocaleString('es-AR')}
                </span>
              </div>
              {expandedId === ext.id ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
            </button>

            {expandedId === ext.id && (
              <div className="border-t px-4 py-4 space-y-4">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                  <div>
                    <span className="text-muted-foreground">Monto</span>
                    <p className="font-medium">{ext.extracted_amount !== null ? `$${Number(ext.extracted_amount).toFixed(2)}` : '—'}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Fecha</span>
                    <p className="font-medium">{ext.extracted_date || '—'}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Banco</span>
                    <p className="font-medium">{ext.extracted_bank || '—'}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Invoice</span>
                    <p className="font-medium">{ext.matched_invoice_id ? `#${ext.matched_invoice_id}` : '—'}</p>
                  </div>
                </div>

                {ext.error_message && (
                  <div className="bg-destructive/10 text-destructive text-sm px-3 py-2 rounded-lg">Error: {ext.error_message}</div>
                )}

                {ext.debug_info && (
                  <div className="space-y-3">
                    <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Matching Flow</h3>

                    {ext.debug_info.phase1 && (
                      <PhaseTimeline phase={ext.debug_info.phase1} label="Phase 1 — Amount-only" />
                    )}

                    {ext.debug_info.phase2 && (
                      <PhaseTimeline phase={ext.debug_info.phase2} label="Phase 2 — Name-based" />
                    )}

                    {ext.debug_info.phase3 && (
                      <div className="border rounded-xl overflow-hidden">
                        <div className="flex items-center justify-between px-4 py-3 text-sm font-medium bg-muted/30">
                          <span>Phase 3 — Ask user</span>
                          <span className="text-muted-foreground font-normal text-xs">
                            {ext.debug_info.phase3.candidatesShown} candidates, {new Set(ext.debug_info.phase3.candidates.map(c => c.cliente)).size} clients
                          </span>
                        </div>
                        {ext.debug_info.phase3.candidates.length > 0 && (
                          <div className="px-4 py-3">
                            <CandidateTable candidates={ext.debug_info.phase3.candidates} />
                          </div>
                        )}
                      </div>
                    )}

                    {ext.debug_info.final && (
                      <div className="border rounded-xl overflow-hidden">
                        <div className="bg-muted/50 px-4 py-2 text-sm font-medium">Final Result</div>
                        <div className="px-4 py-3 text-sm space-y-1">
                          <div className="flex items-center gap-2">
                            <StatusBadge status={ext.debug_info.final.matchStatus} />
                            {ext.debug_info.final.matchedClienteNombre && <span>— {ext.debug_info.final.matchedClienteNombre}</span>}
                          </div>
                          {ext.debug_info.final.matchedInvoiceNumero && (
                            <div><span className="text-muted-foreground">Invoice: </span>{ext.debug_info.final.matchedInvoiceNumero}</div>
                          )}
                          {ext.debug_info.final.matchedSaldoPendiente !== null && (
                            <div><span className="text-muted-foreground">Saldo: </span>${Number(ext.debug_info.final.matchedSaldoPendiente).toFixed(2)}</div>
                          )}
                          {ext.debug_info.final.errorMessage && (
                            <div className="text-destructive"><span className="text-muted-foreground">Error: </span>{ext.debug_info.final.errorMessage}</div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <div className="text-xs text-muted-foreground">
                  <span>Message ID: </span>
                  <code className="bg-muted px-1 py-0.5 rounded">{ext.message_id}</code>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
