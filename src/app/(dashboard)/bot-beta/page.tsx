'use client'

import { useRef, useState } from 'react'
import {
  Bot,
  RotateCcw,
  Send,
  Loader2,
  UserCircle2,
  FlaskConical,
  ShoppingCart,
  FileText,
  List,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import type { CartState } from '@/lib/ai/cart-state'
import type { InvoiceCreatePayload } from '@/lib/ai/build-invoice-payload'

// ─── Tipos de la API ───

interface SandboxLog {
  step: string
  data: Record<string, unknown>
}

interface Turn {
  role: 'user' | 'bot'
  content: string
}

interface SandboxResponse {
  reply: string
  cart: CartState | null
  invoice: InvoiceCreatePayload | null
  logs: SandboxLog[]
}

// ─── Helpers visuales ───

const STEP_LABELS: Record<string, { label: string; color: string }> = {
  extraction: { label: 'Extracción LLM', color: 'bg-blue-500/10 text-blue-400 border-blue-500/30' },
  pricing: { label: 'Precios FacBal', color: 'bg-purple-500/10 text-purple-400 border-purple-500/30' },
  cart_updated: { label: 'Carrito', color: 'bg-green-500/10 text-green-400 border-green-500/30' },
  response: { label: 'Respuesta', color: 'bg-amber-500/10 text-amber-400 border-amber-500/30' },
  confirm_order: { label: 'Confirmación', color: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' },
  pending_confirm: { label: 'Preguntando', color: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30' },
  handoff: { label: 'Derivación', color: 'bg-orange-500/10 text-orange-400 border-orange-500/30' },
  cancel_order: { label: 'Cancelación', color: 'bg-red-500/10 text-red-400 border-red-500/30' },
  view_budget: { label: 'Presupuesto', color: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30' },
  error: { label: 'Error', color: 'bg-red-500/10 text-red-400 border-red-500/30' },
}

const STEP_DESC: Record<string, string> = {
  extraction: 'Intención detectada por OpenRouter',
  pricing: 'Resultado de bulkPrice en FacBal',
  cart_updated: 'Estado actual del carrito',
  response: 'Respuesta generada por el LLM',
  confirm_order: 'Pedido confirmado — invoice generado',
  pending_confirm: 'Bot preguntando antes de confirmar',
  handoff: 'Derivado a agente humano',
  cancel_order: 'Pedido cancelado por el usuario',
  view_budget: 'Presupuesto formateado',
  error: 'Ocurrió un error en el paso',
}

function formatPhone(value: string): string {
  return value.replace(/\D/g, '')
}

// ─── Componente principal ───

export default function BotBetaPage() {
  const [turns, setTurns] = useState<Turn[]>([])
  const [cart, setCart] = useState<CartState | null>(null)
  const [invoice, setInvoice] = useState<InvoiceCreatePayload | null>(null)
  const [logs, setLogs] = useState<SandboxLog[]>([])
  const [phone, setPhone] = useState('1145678901')
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [debugTab, setDebugTab] = useState('cart')
  const scrollRef = useRef<HTMLDivElement>(null)

  // Scroll al último mensaje
  const scrollToBottom = () => {
    setTimeout(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
    }, 100)
  }

  // ─── Enviar mensaje al sandbox ───
  const send = async () => {
    const text = input.trim()
    if (!text || sending) return

    const userTurn: Turn = { role: 'user', content: text }
    const nextTurns = [...turns, userTurn]
    setTurns(nextTurns)
    setInput('')
    setSending(true)

    try {
      const res = await fetch('/api/bot-beta/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          phone,
          history: nextTurns.map((t) => ({ role: t.role, content: t.content })),
          cart,
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        setTurns([...nextTurns, { role: 'bot', content: `Error: ${data.error || 'Error inesperado'}` }])
        scrollToBottom()
        return
      }

      const result = data as SandboxResponse

      // Actualizar estado
      setTurns([...nextTurns, { role: 'bot', content: result.reply }])
      setCart(result.cart)
      setInvoice(result.invoice)
      setLogs(result.logs || [])

      // Si hay invoice, cambiar a esa pestaña
      if (result.invoice) {
        setDebugTab('invoice')
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error de conexión'
      setTurns([...nextTurns, { role: 'bot', content: `Error: ${msg}` }])
    } finally {
      setSending(false)
      scrollToBottom()
    }
  }

  // ─── Resetear sesión ───
  const reset = () => {
    setTurns([])
    setCart(null)
    setInvoice(null)
    setLogs([])
    setDebugTab('cart')
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  return (
    <div>
      {/* ─── Header ─── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FlaskConical className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Bot Beta
          </h1>
          <Badge variant="outline" className="text-[10px] bg-amber-500/10 text-amber-400 border-amber-500/30">
            BETA
          </Badge>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={reset}
          disabled={turns.length === 0 || sending}
          className="text-muted-foreground"
        >
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Reset
        </Button>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Simulá conversaciones de WhatsApp para probar cómo el chatbot crea presupuestos.
        Usa OpenRouter y FacBal reales, pero <strong>no se guarda nada</strong>.
      </p>

      {/* ─── Teléfono ─── */}
      <div className="mt-4 max-w-xs">
        <label className="text-xs font-medium text-muted-foreground mb-1 block">
          Teléfono del cliente simulado
        </label>
        <Input
          value={phone}
          onChange={(e) => setPhone(formatPhone(e.target.value))}
          placeholder="1145678901"
          disabled={sending}
          className="font-mono text-sm"
        />
      </div>

      {/* ─── Cuerpo: dos columnas ─── */}
      <div className="mt-4 flex gap-4" style={{ minHeight: '65vh' }}>
        {/* ─── Columna izquierda: Chat ─── */}
        <div className="flex w-1/2 flex-col rounded-xl border border-border bg-card">
          <div className="border-b border-border px-4 py-2">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Conversación
            </span>
          </div>

          {/* Burbujas de chat */}
          <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-4">
            {turns.length === 0 && (
              <div className="flex h-full flex-col items-center justify-center text-center text-sm text-muted-foreground">
                <Bot className="mb-2 h-8 w-8 text-muted-foreground/60" />
                <p>Escribí un mensaje como si fueras un cliente de WhatsApp.</p>
                <p className="mt-1 text-xs">Ej: "quiero 3 bastidores 60x40 lienzo profesional"</p>
              </div>
            )}

            {turns.map((t, i) => (
              <div
                key={i}
                className={cn(
                  'flex gap-2',
                  t.role === 'user' ? 'justify-end' : 'justify-start',
                )}
              >
                {t.role === 'bot' && (
                  <Bot className="mt-1 h-5 w-5 shrink-0 text-primary" />
                )}
                <div
                  className={cn(
                    'max-w-[85%] rounded-2xl px-3.5 py-2 text-sm',
                    t.role === 'user'
                      ? 'rounded-br-sm bg-primary text-primary-foreground'
                      : 'rounded-bl-sm bg-muted text-foreground',
                  )}
                >
                  <p className="whitespace-pre-wrap">{t.content}</p>
                </div>
                {t.role === 'user' && (
                  <UserCircle2 className="mt-1 h-5 w-5 shrink-0 text-muted-foreground" />
                )}
              </div>
            ))}

            {sending && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Bot className="h-5 w-5 text-primary" />
                <Loader2 className="h-4 w-4 animate-spin" /> Pensando…
              </div>
            )}
          </div>

          {/* Composer */}
          <div className="flex items-end gap-2 border-t border-border p-3">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Escribí el mensaje del cliente…"
              rows={1}
              disabled={sending}
              className="flex-1 resize-none rounded-xl border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
            />
            <Button
              size="sm"
              onClick={send}
              disabled={!input.trim() || sending}
              className="h-9 w-9 shrink-0 p-0"
            >
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>

        {/* ─── Columna derecha: Debug Panel ─── */}
        <div className="flex w-1/2 flex-col rounded-xl border border-border bg-card">
          <div className="border-b border-border px-4 py-2">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Debug
            </span>
          </div>

          <Tabs value={debugTab} onValueChange={setDebugTab} className="flex flex-1 flex-col">
            <div className="border-b border-border px-3">
              <TabsList className="h-9">
                <TabsTrigger value="cart" className="text-xs gap-1.5">
                  <ShoppingCart className="h-3.5 w-3.5" /> Carrito
                </TabsTrigger>
                <TabsTrigger value="invoice" className="text-xs gap-1.5">
                  <FileText className="h-3.5 w-3.5" /> Factura
                </TabsTrigger>
                <TabsTrigger value="logs" className="text-xs gap-1.5">
                  <List className="h-3.5 w-3.5" /> Pasos
                </TabsTrigger>
              </TabsList>
            </div>

            {/* ─── Tab: Carrito ─── */}
            <TabsContent value="cart" className="flex-1 overflow-y-auto p-4 m-0">
              {!cart ? (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  <ShoppingCart className="mr-2 h-5 w-5 opacity-50" />
                  Todavía no hay productos en el carrito.
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Estado del carrito */}
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="outline"
                      className={cn(
                        'text-[10px]',
                        cart.status === 'confirmado'
                          ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                          : cart.pending_confirm
                            ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30'
                            : 'bg-blue-500/10 text-blue-400 border-blue-500/30',
                      )}
                    >
                      {cart.status === 'confirmado' ? 'CONFIRMADO' : cart.pending_confirm ? 'PENDIENTE CONFIRMAR' : 'COTIZANDO'}
                    </Badge>
                    {cart.items_faltantes.length > 0 && (
                      <Badge variant="outline" className="text-[10px] bg-red-500/10 text-red-400 border-red-500/30">
                        {cart.items_faltantes.length} faltante(s)
                      </Badge>
                    )}
                  </div>

                  {/* Items */}
                  <div className="space-y-2">
                    {cart.items.map((item, i) => (
                      <div key={i} className="rounded-lg border border-border bg-muted/50 p-3 text-sm">
                        <div className="flex items-center justify-between">
                          <span className="font-medium text-foreground">
                            {item.cantidad}x {item.categoria} {item.medida}
                            {item.variante ? ` (${item.variante})` : ''}
                          </span>
                          {item.precio_unitario != null ? (
                            <span className="font-mono text-foreground">
                              ${item.subtotal?.toLocaleString('es-AR')}
                            </span>
                          ) : (
                            <Badge variant="outline" className="text-[10px] bg-red-500/10 text-red-400 border-red-500/30">
                              Sin precio
                            </Badge>
                          )}
                        </div>
                        {item.precio_unitario != null && (
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            ${item.precio_unitario.toLocaleString('es-AR')} c/u
                          </p>
                        )}
                      </div>
                    ))}
                  </div>

                  {/* Total */}
                  <div className="flex items-center justify-between rounded-lg border border-primary/20 bg-primary/5 p-3">
                    <span className="text-sm font-semibold text-foreground">TOTAL</span>
                    <span className="text-lg font-bold font-mono text-foreground">
                      ${cart.total.toLocaleString('es-AR')}
                    </span>
                  </div>

                  {/* Items faltantes */}
                  {cart.items_faltantes.length > 0 && (
                    <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
                      <p className="text-xs font-medium text-red-400 mb-1">Productos sin precio:</p>
                      {cart.items_faltantes.map((f, i) => (
                        <p key={i} className="text-xs text-red-300">- {f}</p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </TabsContent>

            {/* ─── Tab: Factura ─── */}
            <TabsContent value="invoice" className="flex-1 overflow-y-auto p-4 m-0">
              {!invoice ? (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  <FileText className="mr-2 h-5 w-5 opacity-50" />
                  Confirmá un pedido para ver la vista previa de la factura.
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Resumen del invoice */}
                  <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
                    <p className="text-xs font-medium text-emerald-400 mb-1">Vista previa del presupuesto</p>
                    <p className="text-xs text-muted-foreground">
                      Este es el JSON exacto que se enviaría a <code className="text-emerald-400">POST /invoices</code> en FacBal.
                    </p>
                  </div>

                  {/* JSON formateado */}
                  <pre className="rounded-lg bg-muted p-4 overflow-x-auto font-mono text-xs text-foreground whitespace-pre-wrap">
                    {JSON.stringify(invoice, null, 2)}
                  </pre>
                </div>
              )}
            </TabsContent>

            {/* ─── Tab: Pasos (Logs) ─── */}
            <TabsContent value="logs" className="flex-1 overflow-y-auto p-4 m-0">
              {logs.length === 0 ? (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  <List className="mr-2 h-5 w-5 opacity-50" />
                  Los pasos del chatbot aparecerán acá.
                </div>
              ) : (
                <div className="space-y-2">
                  {logs.map((log, i) => {
                    const meta = STEP_LABELS[log.step] || { label: log.step, color: 'bg-muted text-muted-foreground border-border' }
                    const desc = STEP_DESC[log.step] || ''
                    return (
                      <div key={i} className="rounded-lg border border-border p-3">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge variant="outline" className={`text-[10px] ${meta.color}`}>
                            {meta.label}
                          </Badge>
                          <span className="text-[10px] text-muted-foreground">
                            Paso {i + 1}
                          </span>
                        </div>
                        {desc && (
                          <p className="mt-1 text-xs text-muted-foreground">{desc}</p>
                        )}
                        <pre className="mt-1.5 text-[11px] text-foreground/80 font-mono whitespace-pre-wrap overflow-x-auto">
                          {JSON.stringify(log.data, null, 2)}
                        </pre>
                      </div>
                    )
                  })}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  )
}
