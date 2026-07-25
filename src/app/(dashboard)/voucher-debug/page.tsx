'use client'

import { useEffect, useState } from 'react'
import { Search, Check, X, AlertTriangle, ChevronDown, ChevronRight, Bug, Users } from 'lucide-react'
import { Badge } from '@/components/ui/badge'

interface PhaseInfo {
  apiCall: Record<string, unknown>
  apiResult: { factura: string; cliente: string; saldo: number; score: number }[]
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
    phase3: { candidatesShown: number; candidates: { factura: string; cliente: string; saldo: number }[] } | null
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

function StatusBadge({ status }: { status: string }) {
  const variant = status === 'matched' ? 'default' : status === 'ambiguous' ? 'secondary' : 'destructive'
  const icon = status === 'matched' ? <Check className="h-3 w-3" /> : status === 'ambiguous' ? <AlertTriangle className="h-3 w-3" /> : <X className="h-3 w-3" />
  return (
    <Badge variant={variant} className="inline-flex items-center gap-1">
      {icon}
      {status}
    </Badge>
  )
}

function StepDot({ done, children }: { done: boolean; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 ${done ? 'text-foreground' : 'text-muted-foreground/50'}`}>
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${done ? 'bg-primary' : 'bg-muted-foreground/30'}`} />
      {children}
    </span>
  )
}

function PhaseBlock({ phase, label }: { phase: PhaseInfo | null; label: string }) {
  const [open, setOpen] = useState(false)
  if (!phase) return null

  return (
    <div className="border rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between bg-muted/50 px-4 py-2 text-left text-sm font-medium hover:bg-muted/80"
      >
        <span>{label}</span>
        <div className="flex items-center gap-2">
          <StatusBadge status={phase.result?.status || 'unknown'} />
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </div>
      </button>
      {open && (
        <div className="px-4 py-3 space-y-3 text-sm">
          <div className="flex items-center gap-2 text-xs text-muted-foreground border-b pb-2 mb-1">
            <StepDot done>1. Exact match</StepDot>
            <span className="text-muted-foreground/30">→</span>
            <StepDot done={phase.result?.status === 'matched' || phase.result?.status === 'multi_invoice' || phase.result?.status === 'ambiguous'}>2. Exact sum</StepDot>
            <span className="text-muted-foreground/30">→</span>
            <StepDot done={phase.result?.status === 'multi_invoice' || phase.result?.status === 'ambiguous'}>3. Close match</StepDot>
          </div>

          <div>
            <span className="font-medium">API Call:</span>{' '}
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
              {JSON.stringify(phase.apiCall)}
            </code>
          </div>

          {phase.apiResult.length > 0 && (
            <div>
              <span className="font-medium">API Result ({phase.apiResult.length} candidates):</span>
              <table className="w-full mt-1 text-xs border-collapse">
                <thead>
                  <tr className="border-b text-muted-foreground">
                    <th className="py-1 pr-2 text-left">Factura</th>
                    <th className="py-1 pr-2 text-left">Cliente</th>
                    <th className="py-1 pr-2 text-right">Saldo</th>
                    <th className="py-1 text-right">Score</th>
                  </tr>
                </thead>
                <tbody>
                  {phase.apiResult.map((c, i) => (
                    <tr key={i} className="border-b border-muted/50">
                      <td className="py-1 pr-2 font-mono">{c.factura}</td>
                      <td className="py-1 pr-2">{c.cliente}</td>
                      <td className="py-1 pr-2 text-right">${c.saldo.toFixed(2)}</td>
                      <td className="py-1 text-right">{c.score.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div>
            <span className="font-medium">Result:</span>{' '}
            <span>{phase.result.status}</span>
            {phase.result.matchedInvoiceId && (
              <span> (invoice #{phase.result.matchedInvoiceId})</span>
            )}
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
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        Cargando...
      </div>
    )
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
          <p className="text-sm text-muted-foreground mt-1">
            {extractions.length} extractions registradas
          </p>
        </div>
      </div>

      {extractions.length === 0 && (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <Search className="h-12 w-12 text-muted-foreground/40 mb-4" />
          <h2 className="text-lg font-medium">Sin datos</h2>
          <p className="text-sm text-muted-foreground mt-1">
            No hay extractions registradas aún. Enviá un comprobante de pago para ver el proceso aquí.
          </p>
        </div>
      )}

      <div className="space-y-4">
        {extractions.map((ext) => (
          <div key={ext.id} className="border rounded-xl bg-card">
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
                  <span className="text-muted-foreground truncate text-sm">
                    {ext.extracted_reference}
                  </span>
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
                  <div className="bg-destructive/10 text-destructive text-sm px-3 py-2 rounded-lg">
                    Error: {ext.error_message}
                  </div>
                )}

                {ext.debug_info && (
                  <div className="space-y-2">
                    <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Matching Flow</h3>
                    <PhaseBlock phase={ext.debug_info.phase1} label="Phase 1 — Amount-only" />
                    <PhaseBlock phase={ext.debug_info.phase2} label="Phase 2 — Name-based" />
                    {ext.debug_info.phase3 && (
                      <div className="border rounded-lg overflow-hidden">
                        <div className="bg-muted/50 px-4 py-2 text-sm font-medium flex items-center gap-2">
                          <span>Phase 3 — Ask user</span>
                          <span className="text-muted-foreground font-normal">
                            ({ext.debug_info.phase3.candidatesShown} candidates, {new Set(ext.debug_info.phase3.candidates.map(c => c.cliente)).size} clients)
                          </span>
                        </div>
                        {ext.debug_info.phase3.candidates.length > 0 && (
                          <div className="px-4 py-3">
                            <table className="w-full text-xs border-collapse">
                              <thead>
                                <tr className="border-b text-muted-foreground">
                                  <th className="py-1 pr-2 text-left">Factura</th>
                                  <th className="py-1 pr-2 text-left">Cliente</th>
                                  <th className="py-1 text-right">Saldo</th>
                                </tr>
                              </thead>
                              <tbody>
                                {ext.debug_info.phase3.candidates.map((c, i) => (
                                  <tr key={i} className="border-b border-muted/50">
                                    <td className="py-1 pr-2 font-mono">{c.factura}</td>
                                    <td className="py-1 pr-2">{c.cliente}</td>
                                    <td className="py-1 text-right">${c.saldo.toFixed(2)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    )}
                    {ext.debug_info.final && (
                      <div className="border rounded-lg overflow-hidden">
                        <div className="bg-muted/50 px-4 py-2 text-sm font-medium">Final Result</div>
                        <div className="px-4 py-3 text-sm space-y-1">
                          <div><span className="text-muted-foreground">Status: </span>{ext.debug_info.final.matchStatus}</div>
                          {ext.debug_info.final.matchedClienteNombre && (
                            <div><span className="text-muted-foreground">Client: </span>{ext.debug_info.final.matchedClienteNombre}</div>
                          )}
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
