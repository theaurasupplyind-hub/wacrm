'use client'

import { useEffect, useState } from 'react'
import { Search, Check, X, AlertTriangle, ChevronDown, ChevronRight, Bug, Users, ArrowRight, DollarSign, User, Layers, HelpCircle } from 'lucide-react'
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
  input?: CandidateInfo[]
  filters?: Record<string, unknown>
  result: Record<string, unknown>
}

interface PhaseBaseInfo {
  apiCall: Record<string, unknown>
  apiResult?: CandidateInfo[]
  steps?: StepInfo[]
  result: Record<string, unknown>
}

interface DecisionInfo {
  poolSize: number
  entries: { type: string; clientName: string; total: number; invoiceCount: number }[]
  finalStatus: string
}

interface Phase4Info {
  wideSearch: { tolerancia: number; candidates: number; timeout: boolean }
  result: { status: string; candidatesShown: number }
}

interface Phase4NameResolutionInfo {
  hasName: boolean
  nameIsReliable: boolean
  nameCandidatesCount: number
  bestNameScore: number | null
  poolBefore: number
  steps?: StepInfo[]
  result: number
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
    phase1: PhaseBaseInfo | null
    phase2: PhaseBaseInfo | null
    phase3: PhaseBaseInfo | null
    phase4: Phase4NameResolutionInfo | null
    decision: DecisionInfo | null
    phase5: Phase4Info | null
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
  if (!candidates || candidates.length === 0) return <p className="text-xs text-muted-foreground">Sin candidatos</p>
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
  if (step === 'Exact amount') return <DollarSign className="h-3.5 w-3.5 text-blue-500" />
  if (step === 'Exact sum') return <Layers className="h-3.5 w-3.5 text-green-500" />
  if (step === 'Name match') return <User className="h-3.5 w-3.5 text-purple-500" />
  return <ArrowRight className="h-3.5 w-3.5" />
}

function GroupsDisplay({ groups }: { groups: { clientName: string; total: number; invoices: { factura: string; saldo: number }[] }[] }) {
  if (!groups || groups.length === 0) return null
  return (
    <div>
      {groups.map((g, i) => (
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
  )
}

function StepBlock({ step }: { step: StepInfo }) {
  const [open, setOpen] = useState(false)
  const result = step.result || {}
  const hasInput = step.input && step.input.length > 0
  const hasGroups = Array.isArray(result.groups) && result.groups.length > 0

  return (
    <div className="border rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium hover:bg-muted/50 bg-muted/30"
      >
        <div className="flex items-center gap-2 min-w-0">
          <StepIcon step={step.step} />
          <span className="truncate">{step.step}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </div>
      </button>

      {open && (
        <div className="px-3 py-2 space-y-2 text-xs">
          {hasInput && (
            <div>
              <span className="font-medium text-muted-foreground">Input ({step.input!.length} candidates):</span>
              <CandidateTable candidates={step.input!} showScore />
            </div>
          )}

          {hasGroups && <GroupsDisplay groups={result.groups as { clientName: string; total: number; invoices: { factura: string; saldo: number }[] }[]} />}

          {result.apiCandidates !== undefined && (
            <div className="text-muted-foreground">API candidates: <span className="font-medium text-foreground">{String(result.apiCandidates)}</span></div>
          )}
          {result.exactMatches !== undefined && (
            <div className="text-muted-foreground">Exact matches: <span className="font-medium text-green-600">{String(result.exactMatches)}</span></div>
          )}
          {result.exactWithName !== undefined && (
            <div className="text-muted-foreground">Exact + name: <span className="font-medium text-green-600">{String(result.exactWithName)}</span></div>
          )}
          {result.totalGroups !== undefined && (
            <div className="text-muted-foreground">Sum groups: <span className="font-medium">{String(result.totalGroups)}</span></div>
          )}
          {result.addedToPool !== undefined && (
            <div className="text-muted-foreground">Added to pool: <span className="font-medium text-green-600">{String(result.addedToPool)}</span></div>
          )}
        </div>
      )}
    </div>
  )
}

function PhaseTimeline({ phase, label }: { phase: PhaseBaseInfo | null; label: string }) {
  const [open, setOpen] = useState(false)
  if (!phase) return null

  const hasSteps = phase.steps && phase.steps.length > 0
  const poolAdded = typeof phase.result?.poolAdded === 'number' ? phase.result.poolAdded : 0
  const resolved = poolAdded > 0

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
          {poolAdded > 0 ? <StatusBadge status="matched" small /> : <span className="text-xs text-muted-foreground">0 added</span>}
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </div>
      </button>

      {open && (
        <div className="border-t px-4 py-3 space-y-3 text-sm">
          <div>
            <span className="text-xs text-muted-foreground">API Call:</span>{' '}
            <code className="text-[11px] bg-muted px-1.5 py-0.5 rounded">{JSON.stringify(phase.apiCall)}</code>
          </div>

          {phase.apiResult && phase.apiResult.length > 0 && (
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
            Added to pool: {poolAdded}
            {phase.result?.apiCandidates !== undefined && <span> (from {String(phase.result.apiCandidates)} API candidates)</span>}
          </div>
        </div>
      )}
    </div>
  )
}

function PoolEntryBadge({ type }: { type: string }) {
  if (type === 'single') return <span className="text-[10px] text-blue-600 bg-blue-100 dark:bg-blue-950 px-1.5 py-0.5 rounded font-medium">single</span>
  if (type === 'sum') return <span className="text-[10px] text-green-600 bg-green-100 dark:bg-green-950 px-1.5 py-0.5 rounded font-medium">sum</span>
  return null
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

                    <PhaseTimeline phase={ext.debug_info.phase1} label="Phase 1 — Exact amount" />
                    <PhaseTimeline phase={ext.debug_info.phase2} label="Phase 2 — Client sum" />
                    <PhaseTimeline phase={ext.debug_info.phase3} label="Phase 3 — Name + amount" />

                    {ext.debug_info.phase4 && (
                      <div className="border rounded-xl overflow-hidden">
                        <div className="flex items-center justify-between px-4 py-3 text-sm font-medium bg-muted/30">
                          <span className="flex items-center gap-2">
                            <User className="h-4 w-4 text-blue-500" />
                            Phase 4 — Name resolution
                          </span>
                          <span className="text-xs text-muted-foreground">Result: {ext.debug_info.phase4.result}</span>
                        </div>
                        <div className="px-4 py-3 space-y-1 text-xs">
                          <div className="text-muted-foreground">Has name: <span className={`font-medium ${ext.debug_info.phase4.hasName ? 'text-green-600' : 'text-destructive'}`}>{ext.debug_info.phase4.hasName ? 'Yes' : 'No'}</span></div>
                          <div className="text-muted-foreground">Name reliable: <span className={`font-medium ${ext.debug_info.phase4.nameIsReliable ? 'text-green-600' : 'text-orange-500'}`}>{ext.debug_info.phase4.nameIsReliable ? 'Yes' : 'No'}</span></div>
                          <div className="text-muted-foreground">Name candidates: <span className="font-medium text-foreground">{ext.debug_info.phase4.nameCandidatesCount}</span></div>
                          {ext.debug_info.phase4.bestNameScore !== null && (
                            <div className="text-muted-foreground">Best score: <span className="font-medium text-foreground">{ext.debug_info.phase4.bestNameScore}</span></div>
                          )}
                          <div className="text-muted-foreground">Pool before: <span className="font-medium text-foreground">{ext.debug_info.phase4.poolBefore}</span></div>
                          {ext.debug_info.phase4.steps && ext.debug_info.phase4.steps.length > 0 && (
                            <div className="space-y-1 mt-1 pt-1 border-t border-muted">
                              {ext.debug_info.phase4.steps.map((s, si) => (
                                <div key={si}>
                                  <div className="font-medium text-muted-foreground">{s.step}</div>
                                  {s.result && (s.result as Record<string, unknown>).factura
                                    ? <div className="text-muted-foreground/70">Factura: {String((s.result as Record<string, unknown>).factura)} — {String((s.result as Record<string, unknown>).cliente)} (score: {String((s.result as Record<string, unknown>).score)})</div>
                                    : null}
                                  <div className="text-muted-foreground/70">{JSON.stringify(s.result)}</div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {ext.debug_info.decision && (
                      <div className="border rounded-xl overflow-hidden">
                        <div className="flex items-center justify-between px-4 py-3 text-sm font-medium bg-muted/30">
                          <span className="flex items-center gap-2">
                            <HelpCircle className="h-4 w-4 text-amber-500" />
                            Decision
                          </span>
                          <StatusBadge status={ext.debug_info.decision.finalStatus} small />
                        </div>
                        <div className="px-4 py-3 space-y-2 text-sm">
                          <div className="text-xs text-muted-foreground">Pool size: <span className="font-medium text-foreground">{ext.debug_info.decision.poolSize}</span></div>
                          {ext.debug_info.decision.entries.length > 0 && (
                            <div className="space-y-1.5">
                              {ext.debug_info.decision.entries.map((e, i) => (
                                <div key={i} className="flex items-center gap-2 p-2 rounded bg-muted/30 text-xs">
                                  <PoolEntryBadge type={e.type} />
                                  <span className="font-medium">{e.clientName}</span>
                                  <span className="text-muted-foreground">— ${e.total.toFixed(2)}</span>
                                  {e.invoiceCount > 1 && <span className="text-muted-foreground">({e.invoiceCount} facturas)</span>}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {ext.debug_info.phase5 && (
                      <div className="border rounded-xl overflow-hidden">
                        <div className="flex items-center justify-between px-4 py-3 text-sm font-medium bg-muted/30">
                          <span className="flex items-center gap-2">
                            <Search className="h-4 w-4 text-orange-500" />
                            Phase 5 — Wide search
                          </span>
                          <StatusBadge status={ext.debug_info.phase5.result.status} small />
                        </div>
                        <div className="px-4 py-3 space-y-1 text-xs">
                          <div className="text-muted-foreground">Tolerancia: <span className="font-medium text-foreground">{ext.debug_info.phase5.wideSearch.tolerancia}</span></div>
                          <div className="text-muted-foreground">Candidates: <span className="font-medium text-foreground">{ext.debug_info.phase5.wideSearch.candidates}</span></div>
                          <div className="text-muted-foreground">Timeout: <span className={`font-medium ${ext.debug_info.phase5.wideSearch.timeout ? 'text-destructive' : 'text-green-600'}`}>{ext.debug_info.phase5.wideSearch.timeout ? 'Yes' : 'No'}</span></div>
                          <div className="text-muted-foreground">Shown to user: <span className="font-medium text-foreground">{ext.debug_info.phase5.result.candidatesShown}</span></div>
                        </div>
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
