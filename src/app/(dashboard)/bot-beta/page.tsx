'use client'

import { useRef, useState, useCallback } from 'react'
import {
  Bot,
  RotateCcw,
  Send,
  Loader2,
  UserCircle2,
  FlaskConical,
  List,
  Mic,
  Square,
  Upload,
  Volume2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import type { VoiceOrderResult } from '@/lib/voice-orders/types'

interface Turn {
  role: 'user' | 'bot'
  content: string
  voiceResult?: VoiceOrderResult
}

const VOICE_STEP_LABELS: Record<string, { label: string; color: string }> = {
  voice_transcribe: { label: 'Transcripción', color: 'bg-sky-500/10 text-sky-400 border-sky-500/30' },
  voice_parse: { label: 'Parseo LLM', color: 'bg-blue-500/10 text-blue-400 border-blue-500/30' },
  voice_client_search: { label: 'Buscar Cliente', color: 'bg-teal-500/10 text-teal-400 border-teal-500/30' },
  voice_client_create: { label: 'Crear Cliente', color: 'bg-teal-500/10 text-teal-400 border-teal-500/30' },
  voice_pricing: { label: 'Precios FacBal', color: 'bg-purple-500/10 text-purple-400 border-purple-500/30' },
  voice_invoice: { label: 'Presupuesto', color: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' },
  voice_error: { label: 'Error', color: 'bg-red-500/10 text-red-400 border-red-500/30' },
}

function formatPhone(value: string): string {
  return value.replace(/\D/g, '')
}

function formatVoiceResult(result: VoiceOrderResult): string {
  let s = ''
  if (result.transcription) {
    s += `📝 "${result.transcription}"\n\n`
  }
  if (result.parsedOrder) {
    s += `👤 Cliente: ${result.parsedOrder.cliente_nombre}\n`
    for (const item of result.parsedOrder.items) {
      s += `📦 ${item.cantidad}x ${item.descripcion}\n`
    }
    s += '\n'
  }
  if (result.client) {
    s += `✅ Cliente: ${result.client.nombre}${result.client.id ? ` (ID: ${result.client.id})` : ' (nuevo)'}\n\n`
  }
  if (result.pricing) {
    for (const item of result.pricing.items) {
      if (item.precio != null) {
        s += `✅ ${item.cantidad}x ${item.categoria} ${item.medida_solicitada} → $${(item.precio * item.cantidad).toLocaleString('es-AR')}\n`
      } else {
        s += `❌ ${item.cantidad}x ${item.categoria} ${item.medida_solicitada} → SIN PRECIO\n`
      }
    }
    s += `\n💰 Total: $${result.pricing.total.toLocaleString('es-AR')}\n\n`
  }
  if (result.invoice) {
    s += `✅ Presupuesto creado: ${result.invoice.numero}\n`
  }
  if (result.error) {
    s += `\n❌ Error: ${result.error}`
  }
  return s
}

export default function BotBetaPage() {
  const [turns, setTurns] = useState<Turn[]>([])
  const [logs, setLogs] = useState<VoiceOrderResult['logs']>([])
  const [voiceResult, setVoiceResult] = useState<VoiceOrderResult | null>(null)
  const [phone, setPhone] = useState('1145678901')
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [debugTab, setDebugTab] = useState('cart')

  // Audio recording state
  const [recording, setRecording] = useState(false)
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  const scrollRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = () => {
    setTimeout(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
    }, 100)
  }

  // ─── Text send ───
  const sendText = async () => {
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
          pendingVariantItems: voiceResult?.pendingVariantItems,
        }),
      })
      const result: VoiceOrderResult & { error?: string } = await res.json()

      if (!res.ok || result.error) {
        setTurns([...nextTurns, { role: 'bot', content: `Error: ${result.error || 'Error inesperado'}` }])
        scrollToBottom()
        return
      }

      const formatted = formatVoiceResult(result)
      setTurns([...nextTurns, { role: 'bot', content: formatted, voiceResult: result }])
      setVoiceResult(result)
      setLogs(result.logs || [])
      setDebugTab('voice_logs')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error de conexión'
      setTurns([...nextTurns, { role: 'bot', content: `Error: ${msg}` }])
    } finally {
      setSending(false)
      scrollToBottom()
    }
  }

  // ─── Audio recording ───
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      chunksRef.current = []
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
      mediaRecorderRef.current = recorder

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }

      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop())
        const blob = new Blob(chunksRef.current, { type: 'audio/webm;codecs=opus' })
        setAudioBlob(blob)
      }

      recorder.start()
      setRecording(true)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error al acceder al micrófono'
      setTurns([...turns, { role: 'bot', content: `Error: ${msg}` }])
    }
  }

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop()
    }
    setRecording(false)
  }

  // ─── File upload ───
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setAudioBlob(file)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  // ─── Send audio ───
  const sendAudio = useCallback(async () => {
    if (!audioBlob || sending) return

    const userTurn: Turn = { role: 'user', content: '🎤 Audio enviado' }
    const nextTurns = [...turns, userTurn]
    setTurns(nextTurns)
    setAudioBlob(null)
    setSending(true)

    try {
      const formData = new FormData()
      formData.append('audio', audioBlob, 'audio.webm')
      formData.append('phone', phone)
      formData.append('name', 'Cliente de prueba')

      const res = await fetch('/api/bot-beta/voice-run', {
        method: 'POST',
        body: formData,
      })

      const result: VoiceOrderResult & { error?: string } = await res.json()

      if (!res.ok || result.error) {
        setTurns([...nextTurns, { role: 'bot', content: `Error: ${result.error || 'Error inesperado'}` }])
        scrollToBottom()
        return
      }

      const formatted = formatVoiceResult(result)
      setTurns([...nextTurns, { role: 'bot', content: formatted, voiceResult: result }])
      setVoiceResult(result)
      setLogs(result.logs || [])
      setDebugTab('voice_logs')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error de conexión'
      setTurns([...nextTurns, { role: 'bot', content: `Error: ${msg}` }])
    } finally {
      setSending(false)
      scrollToBottom()
    }
  }, [audioBlob, sending, turns, phone])

  // ─── Reset ───
  const reset = () => {
    setTurns([])
    setLogs([])
    setVoiceResult(null)
    setDebugTab('cart')
    setAudioBlob(null)
    setRecording(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void sendText()
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
        Probá el sistema de órdenes por voz. Grabá un audio o escribí un mensaje.
        Usa OpenRouter y FacBal reales.
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
                <p>Grabá un audio o escribí un mensaje.</p>
                <p className="mt-1 text-xs">Ej: "factura un presupuesto de 2 bastidores 120x130 lienzo profesional a nombre Jesus"</p>
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
                    'max-w-[85%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap',
                    t.role === 'user'
                      ? 'rounded-br-sm bg-primary text-primary-foreground'
                      : 'rounded-bl-sm bg-muted text-foreground',
                  )}
                >
                  {t.content}
                </div>
                {t.role === 'user' && (
                  <UserCircle2 className="mt-1 h-5 w-5 shrink-0 text-muted-foreground" />
                )}
              </div>
            ))}

            {sending && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Bot className="h-5 w-5 text-primary" />
                <Loader2 className="h-4 w-4 animate-spin" /> Procesando…
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
              variant={recording ? 'destructive' : 'outline'}
              onClick={recording ? stopRecording : startRecording}
              disabled={sending}
              className="h-9 w-9 shrink-0 p-0"
              title={recording ? 'Detener grabación' : 'Grabar audio'}
            >
              {recording ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={sending}
              className="h-9 w-9 shrink-0 p-0"
              title="Subir archivo de audio"
            >
              <Upload className="h-4 w-4" />
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              onChange={handleFileUpload}
              className="hidden"
            />
            <Button
              size="sm"
              onClick={audioBlob ? sendAudio : sendText}
              disabled={(!input.trim() && !audioBlob) || sending}
              className="h-9 w-9 shrink-0 p-0"
            >
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>

          {/* Audio preview */}
          {audioBlob && (
            <div className="flex items-center gap-2 border-t border-border px-3 py-2 bg-muted/30">
              <Volume2 className="h-4 w-4 text-muted-foreground shrink-0" />
              <audio controls className="h-8 flex-1 min-w-0">
                <source src={URL.createObjectURL(audioBlob)} type={audioBlob.type} />
              </audio>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                onClick={() => setAudioBlob(null)}
              >
                Cancelar
              </Button>
            </div>
          )}
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
                <TabsTrigger value="voice_logs" className="text-xs gap-1.5">
                  <Volume2 className="h-3.5 w-3.5" /> Pipeline
                </TabsTrigger>
                <TabsTrigger value="logs" className="text-xs gap-1.5">
                  <List className="h-3.5 w-3.5" /> Logs
                </TabsTrigger>
              </TabsList>
            </div>

            {/* ─── Tab: Pipeline (logs de voz) ─── */}
            <TabsContent value="voice_logs" className="flex-1 overflow-y-auto p-4 m-0">
              {!voiceResult ? (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  <Volume2 className="mr-2 h-5 w-5 opacity-50" />
                  Enviá un audio para ver el pipeline completo.
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Transcripción */}
                  {voiceResult.transcription && (
                    <div className="rounded-lg border border-sky-500/20 bg-sky-500/5 p-3">
                      <p className="text-xs font-medium text-sky-400 mb-1 flex items-center gap-1.5">
                        <Volume2 className="h-3.5 w-3.5" /> Transcripción
                      </p>
                      <p className="text-sm text-foreground">{voiceResult.transcription}</p>
                    </div>
                  )}

                  {/* Orden parseada */}
                  {voiceResult.parsedOrder && (
                    <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3">
                      <p className="text-xs font-medium text-blue-400 mb-1">Orden detectada</p>
                      <p className="text-xs text-foreground">Cliente: {voiceResult.parsedOrder.cliente_nombre}</p>
                      <div className="mt-1 space-y-0.5">
                        {voiceResult.parsedOrder.items.map((item, i) => (
                          <p key={i} className="text-xs text-muted-foreground">
                            {item.cantidad}x {item.descripcion}
                          </p>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Items resueltos */}
                  {voiceResult.resolvedItems && (
                    <div className="rounded-lg border border-indigo-500/20 bg-indigo-500/5 p-3">
                      <p className="text-xs font-medium text-indigo-400 mb-1">Items resueltos (suggestPrice)</p>
                      <div className="space-y-0.5">
                        {voiceResult.resolvedItems.map((item, i) => (
                          <p key={i} className="text-xs text-muted-foreground">
                            {item.cantidad}x {item.descripcion}
                            {item.faltante
                              ? ' ❌ Sin referencia'
                              : ` → ${item.categoria} ${item.medida}${item.variante ? ` (${item.variante})` : ''} $${item.precio_base?.toLocaleString('es-AR')}`
                            }
                            {item.medida_referencia && <span className="text-indigo-400"> (ref: {item.medida_referencia})</span>}
                          </p>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Cliente */}
                  {voiceResult.client && (
                    <div className="rounded-lg border border-teal-500/20 bg-teal-500/5 p-3">
                      <p className="text-xs font-medium text-teal-400 mb-1">Cliente</p>
                      <p className="text-xs text-foreground">
                        {voiceResult.client.nombre}{voiceResult.client.id ? ` (ID: ${voiceResult.client.id})` : ' (nuevo)'}
                      </p>
                    </div>
                  )}

                  {/* Pricing */}
                  {voiceResult.pricing && (
                    <div className="rounded-lg border border-purple-500/20 bg-purple-500/5 p-3">
                      <p className="text-xs font-medium text-purple-400 mb-1">Precios</p>
                      {voiceResult.pricing.items.map((item, i) => (
                        <div key={i} className="space-y-1 border-b border-purple-500/10 pb-2 mb-2 last:border-0 last:pb-0 last:mb-0">
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-foreground font-medium">
                              {item.cantidad}x {item.categoria} {item.medida_solicitada}
                            </span>
                            {item.precio != null ? (
                              <span className="font-mono text-foreground">${(item.precio * item.cantidad).toLocaleString('es-AR')}</span>
                            ) : (
                              <XCircle className="h-3.5 w-3.5 text-red-400" />
                            )}
                          </div>
                          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
                            {item.precio_base != null && (
                              <span className="flex items-center gap-1">
                                Base: <span className="font-mono">${item.precio_base.toLocaleString('es-AR')}</span>
                                {item.medida_referencia && <span>(ref: {item.medida_referencia})</span>}
                              </span>
                            )}
                            {item.regla_aplicada ? (
                              <span className="flex items-center gap-1 text-amber-400">
                                <CheckCircle2 className="h-2.5 w-2.5" /> Regla: {item.regla_aplicada}
                              </span>
                            ) : item.precio_base != null ? (
                              <span className="text-muted-foreground/60">Regla: —</span>
                            ) : null}
                            {item.precio != null && item.precio_base != null && item.precio !== item.precio_base && (
                              <span className="text-purple-400">
                                → Final: <span className="font-mono">${(item.precio * item.cantidad).toLocaleString('es-AR')}</span>
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                      <div className="mt-1.5 flex items-center justify-between border-t border-purple-500/20 pt-1.5">
                        <span className="text-xs font-semibold text-foreground">Total</span>
                        <span className="text-sm font-bold font-mono text-foreground">
                          ${voiceResult.pricing.total.toLocaleString('es-AR')}
                        </span>
                      </div>
                      {voiceResult.pricing.items.some(i => i.faltante) && (
                        <div className="mt-1.5 flex items-center gap-1 text-xs text-red-400">
                          <AlertTriangle className="h-3 w-3" /> Hay productos sin precio
                        </div>
                      )}
                    </div>
                  )}

                  {/* Invoice created */}
                  {voiceResult.invoice ? (
                    <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                      <span className="text-xs text-foreground">
                        Presupuesto <strong>{voiceResult.invoice.numero}</strong> creado exitosamente
                      </span>
                    </div>
                  ) : voiceResult.error ? (
                    <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 flex items-center gap-2">
                      <XCircle className="h-4 w-4 text-red-400" />
                      <span className="text-xs text-foreground">Error: {voiceResult.error}</span>
                    </div>
                  ) : voiceResult.transcription ? (
                    <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 text-amber-400" />
                      <span className="text-xs text-foreground">Modo preview — no se creó presupuesto real</span>
                    </div>
                  ) : null}

                  {/* Pipeline logs */}
                  {voiceResult.logs.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-xs font-medium text-muted-foreground">Pipeline completo:</p>
                      {voiceResult.logs.filter(l => l.step !== 'voice_error').map((log, i) => {
                        const meta = VOICE_STEP_LABELS[log.step] || { label: log.step, color: 'bg-muted text-muted-foreground border-border' }
                        return (
                          <div key={i} className="rounded-lg border border-border p-2.5">
                            <div className="flex items-center gap-2 flex-wrap">
                              <Badge variant="outline" className={`text-[10px] ${meta.color}`}>
                                {meta.label}
                              </Badge>
                            </div>
                            <pre className="mt-1 text-[10px] text-foreground/70 font-mono whitespace-pre-wrap overflow-x-auto">
                              {JSON.stringify(log.data, null, 2)}
                            </pre>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  )
}
