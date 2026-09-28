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
  MessageCircle,
  Search,
  Wrench,
  FileText,
  Receipt,
  FileImage,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import type { UnifiedExtraction } from '@/lib/bot-llm/types'

interface Turn {
  role: 'user' | 'bot'
  content: string
}

interface AssistantDebug {
  reply: string
  extraction: UnifiedExtraction | null
  toolResults: Record<string, unknown> | null
  knowledge: string[]
  logs: { step: string; data: unknown }[]
  toolLogs?: { tool: string; duration_ms: number; resultCount?: number; error?: string }[]
  transcription?: string
  error?: string
}

interface VoucherDebug {
  mode: 'text' | 'file'
  dryRun: boolean
  wouldWrite: boolean
  matchStatus: string
  candidates: { invoice_id: number; numero_factura: string; cliente_nombre: string; saldo_pendiente: number; score?: number }[]
  matchedInvoiceId: number | null
  matchedInvoiceNumero: string | null
  matchedClienteNombre: string | null
  mensajeRespuesta: string
  extraction: unknown
  debugInfo: Record<string, unknown>
  banner: string
  error?: string
}

const VOICE_STEP_LABELS: Record<string, { label: string; color: string }> = {
  voice_transcribe: { label: 'Transcripción', color: 'bg-sky-500/10 text-sky-400 border-sky-500/30' },
  voice_parse: { label: 'Parseo LLM', color: 'bg-blue-500/10 text-blue-400 border-blue-500/30' },
  voice_client_search: { label: 'Buscar Cliente', color: 'bg-teal-500/10 text-teal-400 border-teal-500/30' },
  voice_client_create: { label: 'Crear Cliente', color: 'bg-teal-500/10 text-teal-400 border-teal-500/30' },
  voice_pricing: { label: 'Precios FacBal', color: 'bg-purple-500/10 text-purple-400 border-purple-500/30' },
  voice_invoice: { label: 'Presupuesto', color: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' },
  voice_error: { label: 'Error', color: 'bg-red-500/10 text-red-400 border-red-500/30' },
  assistant_history: { label: 'Historial', color: 'bg-slate-500/10 text-slate-400 border-slate-500/30' },
  assistant_extraction: { label: 'Extracción', color: 'bg-blue-500/10 text-blue-400 border-blue-500/30' },
  assistant_tools: { label: 'Tools', color: 'bg-purple-500/10 text-purple-400 border-purple-500/30' },
  assistant_response: { label: 'Respuesta', color: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' },
}

function formatPhone(value: string): string {
  return value.replace(/\D/g, '')
}

export default function BotBetaPage() {
  // Top-level tab: unificado (base prod + asistente) is default; legacy tabs kept behind ?legacy=1
  const [mainTab, setMainTab] = useState('unificado')

  // ─── Teléfono simulado (asistente/vouchers) ───
  const [phone, setPhone] = useState('1145678901')

  // ─── Unificado (base prod + asistente) state — phone dummy aislado
  const [unifiedTurns, setUnifiedTurns] = useState<Turn[]>([])
  const [unifiedInput, setUnifiedInput] = useState('')
  const [unifiedSending, setUnifiedSending] = useState(false)
  const [unifiedDebug, setUnifiedDebug] = useState<(AssistantDebug & { dispatchedTo?: string; dispatchReason?: string; dummyConversationId?: string | null }) | null>(null)
  const [unifiedDebugTab, setUnifiedDebugTab] = useState('extraccion')
  const [unifiedAudioBlob, setUnifiedAudioBlob] = useState<Blob | null>(null)

  // ─── Asistente state (legacy, kept for ?legacy) ───
  const [assistantTurns, setAssistantTurns] = useState<Turn[]>([])
  const [assistantInput, setAssistantInput] = useState('')
  const [assistantSending, setAssistantSending] = useState(false)
  const [assistantDebug, setAssistantDebug] = useState<AssistantDebug | null>(null)
  const [assistantDebugTab, setAssistantDebugTab] = useState('extraccion')
  const [assistantAudioBlob, setAssistantAudioBlob] = useState<Blob | null>(null)

  // ─── Vouchers (dryRun copy) state ───
  const [voucherTurns, setVoucherTurns] = useState<Turn[]>([])
  const [voucherInput, setVoucherInput] = useState('')
  const [voucherFile, setVoucherFile] = useState<File | null>(null)
  const [voucherDebug, setVoucherDebug] = useState<VoucherDebug | null>(null)
  const [voucherDebugTab, setVoucherDebugTab] = useState('extraccion')
  const [voucherSending, setVoucherSending] = useState(false)
  const voucherFileInputRef = useRef<HTMLInputElement>(null)
  const voucherScrollRef = useRef<HTMLDivElement>(null)

  // Audio recording state (shared)
  const [recording, setRecording] = useState(false)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const assistantFileInputRef = useRef<HTMLInputElement>(null)
  const unifiedVoucherInputRef = useRef<HTMLInputElement>(null)
  const [unifiedVoucherFile, setUnifiedVoucherFile] = useState<File | null>(null)
  // Target blob for current mainTab
  const isUnificado = mainTab === 'unificado'
  const isAsistente = mainTab === 'asistente'
  const isVouchers = mainTab === 'vouchers'
  const setActiveAudioBlob = isUnificado ? setUnifiedAudioBlob : isAsistente ? setAssistantAudioBlob : setAssistantAudioBlob
  const activeFileInputRef = isUnificado ? assistantFileInputRef : assistantFileInputRef

  const assistantScrollRef = useRef<HTMLDivElement>(null)
  const unifiedScrollRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = (ref: React.RefObject<HTMLDivElement | null>) => {
    setTimeout(() => {
      ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' })
    }, 100)
  }

  // ─── Unified text send (base prod + asistente, dummy phone) ───
  const sendUnifiedText = async () => {
    const text = unifiedInput.trim()
    if (!text || unifiedSending) return

    const userTurn: Turn = { role: 'user', content: text }
    const nextTurns = [...unifiedTurns, userTurn]
    setUnifiedTurns(nextTurns)
    setUnifiedInput('')
    setUnifiedSending(true)

    try {
      const res = await fetch('/api/bot-beta/unified', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          history: nextTurns.map((t) => ({ role: t.role, content: t.content })),
        }),
      })
      const result: AssistantDebug & { dispatchedTo?: string; dispatchReason?: string; error?: string; dummyConversationId?: string | null } = await res.json()
      if (!res.ok) {
        setUnifiedDebug(result)
        setUnifiedTurns([...nextTurns, { role: 'bot', content: `Error: ${result.error || 'Error inesperado'}` }])
        setUnifiedDebugTab('logs')
        scrollToBottom(unifiedScrollRef)
        return
      }
      setUnifiedDebug(result)
      setUnifiedTurns([...nextTurns, { role: 'bot', content: result.reply }])
      setUnifiedDebugTab('extraccion')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error de conexión'
      setUnifiedTurns([...nextTurns, { role: 'bot', content: `Error: ${msg}` }])
    } finally {
      setUnifiedSending(false)
      scrollToBottom(unifiedScrollRef)
    }
  }

  // ─── Assistant text send (legacy) ───
  const sendAssistantText = async () => {
    const text = assistantInput.trim()
    if (!text || assistantSending) return

    const userTurn: Turn = { role: 'user', content: text }
    const nextTurns = [...assistantTurns, userTurn]
    setAssistantTurns(nextTurns)
    setAssistantInput('')
    setAssistantSending(true)

    try {
      const res = await fetch('/api/bot-beta/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          phone,
          history: nextTurns.map((t) => ({ role: t.role, content: t.content })),
        }),
      })
      const result: AssistantDebug & { error?: string } = await res.json()
      if (!res.ok) {
        setAssistantDebug(result)
        setAssistantTurns([...nextTurns, { role: 'bot', content: `Error: ${result.error || 'Error inesperado'}` }])
        setAssistantDebugTab('logs')
        scrollToBottom(assistantScrollRef)
        return
      }
      setAssistantDebug(result)
      setAssistantTurns([...nextTurns, { role: 'bot', content: result.reply }])
      setAssistantDebugTab('extraccion')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error de conexión'
      setAssistantTurns([...nextTurns, { role: 'bot', content: `Error: ${msg}` }])
    } finally {
      setAssistantSending(false)
      scrollToBottom(assistantScrollRef)
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
        stream.getTracks().forEach((t) => t.stop())
        const blob = new Blob(chunksRef.current, { type: 'audio/webm;codecs=opus' })
        setActiveAudioBlob(blob)
      }

      recorder.start()
      setRecording(true)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error al acceder al micrófono'
      if (isAsistente) {
        setAssistantTurns([...assistantTurns, { role: 'bot', content: `Error: ${msg}` }])
      } else {
        setUnifiedTurns([...unifiedTurns, { role: 'bot', content: `Error: ${msg}` }])
      }
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
    setActiveAudioBlob(file)
    if (activeFileInputRef.current) activeFileInputRef.current.value = ''
  }

  // ─── Send unified audio (dummy phone, base prod) ───
  const sendUnifiedAudio = useCallback(async () => {
    if (!unifiedAudioBlob || unifiedSending) return

    const userTurn: Turn = { role: 'user', content: '🎤 Audio enviado' }
    const nextTurns = [...unifiedTurns, userTurn]
    setUnifiedTurns(nextTurns)
    setUnifiedAudioBlob(null)
    setUnifiedSending(true)

    try {
      const formData = new FormData()
      formData.append('audio', unifiedAudioBlob, 'audio.webm')
      formData.append('history', JSON.stringify(nextTurns.map((t) => ({ role: t.role, content: t.content }))))

      const res = await fetch('/api/bot-beta/unified', {
        method: 'POST',
        body: formData,
      })

      const result: AssistantDebug & { dispatchedTo?: string; error?: string } = await res.json()
      if (!res.ok) {
        setUnifiedDebug(result)
        setUnifiedTurns([...nextTurns, { role: 'bot', content: `Error: ${result.error || 'Error inesperado'}` }])
        setUnifiedDebugTab('logs')
        scrollToBottom(unifiedScrollRef)
        return
      }
      setUnifiedDebug(result)
      const transcriptionNote = result.transcription ? `📝 "${result.transcription}"\n\n` : ''
      setUnifiedTurns([...nextTurns, { role: 'bot', content: transcriptionNote + result.reply }])
      setUnifiedDebugTab('extraccion')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error de conexión'
      setUnifiedTurns([...nextTurns, { role: 'bot', content: `Error: ${msg}` }])
    } finally {
      setUnifiedSending(false)
      scrollToBottom(unifiedScrollRef)
    }
  }, [unifiedAudioBlob, unifiedSending, unifiedTurns])

  // ─── Send assistant audio (legacy) ───
  const sendAssistantAudio = useCallback(async () => {
    if (!assistantAudioBlob || assistantSending) return

    const userTurn: Turn = { role: 'user', content: '🎤 Audio enviado' }
    const nextTurns = [...assistantTurns, userTurn]
    setAssistantTurns(nextTurns)
    setAssistantAudioBlob(null)
    setAssistantSending(true)

    try {
      const formData = new FormData()
      formData.append('audio', assistantAudioBlob, 'audio.webm')
      formData.append('phone', phone)
      formData.append('history', JSON.stringify(nextTurns.map((t) => ({ role: t.role, content: t.content }))))

      const res = await fetch('/api/bot-beta/assistant', {
        method: 'POST',
        body: formData,
      })

      const result: AssistantDebug & { error?: string } = await res.json()
      if (!res.ok) {
        setAssistantDebug(result)
        setAssistantTurns([...nextTurns, { role: 'bot', content: `Error: ${result.error || 'Error inesperado'}` }])
        setAssistantDebugTab('logs')
        scrollToBottom(assistantScrollRef)
        return
      }
      setAssistantDebug(result)
      const transcriptionNote = result.transcription ? `📝 "${result.transcription}"\n\n` : ''
      setAssistantTurns([...nextTurns, { role: 'bot', content: transcriptionNote + result.reply }])
      setAssistantDebugTab('extraccion')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error de conexión'
      setAssistantTurns([...nextTurns, { role: 'bot', content: `Error: ${msg}` }])
    } finally {
      setAssistantSending(false)
      scrollToBottom(assistantScrollRef)
    }
  }, [assistantAudioBlob, assistantSending, assistantTurns, phone])

  // ─── Voucher dryRun send ───
  const sendVoucherText = async () => {
    const text = voucherInput.trim()
    if (!text || voucherSending) return
    const userTurn: Turn = { role: 'user', content: text }
    const nextTurns = [...voucherTurns, userTurn]
    setVoucherTurns(nextTurns)
    setVoucherInput('')
    setVoucherSending(true)
    try {
      const res = await fetch('/api/bot-beta/voucher', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, phone }),
      })
      const result = (await res.json()) as VoucherDebug & { error?: string }
      if (!res.ok) {
        setVoucherDebug(result as unknown as VoucherDebug)
        setVoucherTurns([...nextTurns, { role: 'bot', content: `Error: ${result.error || 'Error inesperado'}` }])
        setVoucherDebugTab('extraccion')
        scrollToBottom(voucherScrollRef)
        return
      }
      setVoucherDebug(result)
      const reply = `🔒 Simulación — ${result.mensajeRespuesta}\n${result.matchedInvoiceNumero ? `→ Se registraría en ${result.matchedClienteNombre} FAC ${result.matchedInvoiceNumero} $${(result as unknown as { matchedSaldoPendiente?: number }).matchedSaldoPendiente ?? ''}` : ''}\n${result.candidates.length ? `\nCandidatas: ${result.candidates.length}` : ''}`
      setVoucherTurns([...nextTurns, { role: 'bot', content: reply }])
      setVoucherDebugTab('extraccion')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error de conexión'
      setVoucherTurns([...nextTurns, { role: 'bot', content: `Error: ${msg}` }])
    } finally {
      setVoucherSending(false)
      scrollToBottom(voucherScrollRef)
    }
  }

  const sendVoucherFile = async () => {
    if (!voucherFile || voucherSending) return
    const userTurn: Turn = { role: 'user', content: `📎 ${voucherFile.name} (${(voucherFile.size / 1024).toFixed(0)} KB)` }
    const nextTurns = [...voucherTurns, userTurn]
    setVoucherTurns(nextTurns)
    const file = voucherFile
    setVoucherFile(null)
    setVoucherSending(true)
    try {
      const fd = new FormData()
      fd.append('file', file, file.name)
      const res = await fetch('/api/bot-beta/voucher', { method: 'POST', body: fd })
      const result = (await res.json()) as VoucherDebug & { error?: string; extraction?: unknown }
      if (!res.ok) {
        setVoucherDebug(result as unknown as VoucherDebug)
        setVoucherTurns([...nextTurns, { role: 'bot', content: `Error: ${result.error || 'Error inesperado'}` }])
        setVoucherDebugTab('extraccion')
        scrollToBottom(voucherScrollRef)
        return
      }
      setVoucherDebug(result)
      const reply = `🔒 Simulación — ${result.mensajeRespuesta}${result.matchedInvoiceNumero ? `\n→ Se registraría ${result.matchedClienteNombre} FAC ${result.matchedInvoiceNumero}` : ''}`
      setVoucherTurns([...nextTurns, { role: 'bot', content: reply }])
      setVoucherDebugTab('extraccion')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error de conexión'
      setVoucherTurns([...nextTurns, { role: 'bot', content: `Error: ${msg}` }])
    } finally {
      setVoucherSending(false)
      scrollToBottom(voucherScrollRef)
    }
  }

  const handleVoucherFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    setVoucherFile(f)
    if (voucherFileInputRef.current) voucherFileInputRef.current.value = ''
  }

  // ─── Reset ───
  const reset = () => {
    if (isUnificado) {
      setUnifiedTurns([])
      setUnifiedDebug(null)
      setUnifiedDebugTab('extraccion')
      setUnifiedAudioBlob(null)
      setUnifiedVoucherFile(null)
      setUnifiedInput('')
    } else if (isVouchers) {
      setVoucherTurns([])
      setVoucherDebug(null)
      setVoucherDebugTab('extraccion')
      setVoucherFile(null)
      setVoucherInput('')
    } else if (isAsistente) {
      setAssistantTurns([])
      setAssistantDebug(null)
      setAssistantDebugTab('extraccion')
      setAssistantAudioBlob(null)
      setAssistantInput('')
    }
    setRecording(false)
  }

  const handleAssistantKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void sendAssistantText()
    }
  }

  const handleUnifiedKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void sendUnifiedText()
    }
  }

  const handleVoucherKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void sendVoucherText()
    }
  }

  const hasAnyTurns = isUnificado ? unifiedTurns.length > 0 : isVouchers ? voucherTurns.length > 0 : assistantTurns.length > 0
  const isSending = isUnificado ? unifiedSending : isVouchers ? voucherSending : assistantSending

  return (
    <div>
      {/* ─── Header ─── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FlaskConical className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Bot Beta</h1>
          <Badge variant="outline" className="text-[10px] bg-amber-500/10 text-amber-400 border-amber-500/30">
            BETA
          </Badge>
        </div>
        <Button variant="ghost" size="sm" onClick={reset} disabled={!hasAnyTurns || isSending} className="text-muted-foreground">
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Reset
        </Button>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        {isUnificado
          ? 'Unificado — base producción (router + phone dummy 11 9999 9999, dryRun) + asistente conversacional. Espeja el pipeline de WhatsApp.'
          : isVouchers
            ? 'Vouchers — probá texto “Tobi pagó $12k en efectivo” o subí comprobante (imagen/PDF). Copia aislada dryRun, no escribe en backend_gal.'
            : isAsistente
              ? 'Asistente conversacional — probá saludos, consultas y registros. Usa OpenRouter y FacBal reales.'
              : 'Probá el asistente: grabá un audio o escribí un mensaje.'}
      </p>

      {/* ─── Teléfono ─── */}
      {isUnificado ? (
        <div className="mt-4 flex items-center gap-2">
          <Badge variant="outline" className="text-xs bg-emerald-500/10 text-emerald-400 border-emerald-500/30">DUMMY 11 9999 9999</Badge>
          <span className="text-xs text-muted-foreground">Conversación aislada por account · dryRun · no toca inbox real</span>
          {unifiedDebug?.dummyConversationId && <span className="text-[10px] font-mono text-muted-foreground">{unifiedDebug.dummyConversationId.slice(0, 8)}</span>}
          {unifiedDebug?.dispatchedTo && <Badge variant="outline" className="text-[10px]">{unifiedDebug.dispatchedTo}:{unifiedDebug.dispatchReason}</Badge>}
        </div>
      ) : (
        <div className="mt-4 max-w-xs">
          <label className="text-xs font-medium text-muted-foreground mb-1 block">Teléfono del cliente simulado</label>
          <Input
            value={phone}
          onChange={(e) => setPhone(formatPhone(e.target.value))}
          placeholder="1145678901"
          disabled={isSending}
          className="font-mono text-sm"
        />
        </div>
      )}

      {/* ─── Tabs superiores: Unificado | Asistente | Vouchers ─── */}
      <Tabs value={mainTab} onValueChange={setMainTab} className="mt-4">
        <TabsList className="h-9">
          <TabsTrigger value="unificado" className="text-xs gap-1.5">
            <Bot className="h-3.5 w-3.5" /> Unificado
          </TabsTrigger>
          <TabsTrigger value="asistente" className="text-xs gap-1.5">
            <MessageCircle className="h-3.5 w-3.5" /> Asistente
          </TabsTrigger>
          <TabsTrigger value="vouchers" className="text-xs gap-1.5">
            <Receipt className="h-3.5 w-3.5" /> Vouchers
          </TabsTrigger>
        </TabsList>

        {/* ─── Tab Unificado (base prod + asistente, dummy phone) ─── */}
        <TabsContent value="unificado" className="mt-4">
          <div className="flex gap-4" style={{ minHeight: '65vh' }}>
            {/* Columna izquierda: Chat Unificado */}
            <div className="flex w-1/2 flex-col rounded-xl border border-border bg-card">
              <div className="border-b border-border px-4 py-2 flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Conversación — Unificado</span>
                {unifiedDebug?.dispatchedTo && <Badge variant="outline" className="text-[10px]">{unifiedDebug.dispatchedTo}:{unifiedDebug.dispatchReason}</Badge>}
              </div>

              <div ref={unifiedScrollRef} className="flex-1 space-y-4 overflow-y-auto p-4">
                {unifiedTurns.length === 0 && (
                  <div className="flex h-full flex-col items-center justify-center text-center text-sm text-muted-foreground">
                    <Bot className="mb-2 h-8 w-8 text-muted-foreground/60" />
                    <p>Unificado — espeja producción.</p>
                    <p className="mt-1 text-xs">Probá: &quot;hola&quot;, &quot;pagué 18k luz&quot;, &quot;llegó juan 8:30&quot;, &quot;¿cuánto gasté hoy?&quot; · dummy 11 9999 9999</p>
                  </div>
                )}

                {unifiedTurns.map((t, i) => (
                  <div key={i} className={cn('flex gap-2', t.role === 'user' ? 'justify-end' : 'justify-start')}>
                    {t.role === 'bot' && <Bot className="mt-1 h-5 w-5 shrink-0 text-primary" />}
                    <div
                      className={cn(
                        'max-w-[85%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap',
                        t.role === 'user' ? 'rounded-br-sm bg-primary text-primary-foreground' : 'rounded-bl-sm bg-muted text-foreground',
                      )}
                    >
                      {t.content}
                    </div>
                    {t.role === 'user' && <UserCircle2 className="mt-1 h-5 w-5 shrink-0 text-muted-foreground" />}
                  </div>
                ))}

                {unifiedSending && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Bot className="h-5 w-5 text-primary" />
                    <Loader2 className="h-4 w-4 animate-spin" /> Procesando…
                  </div>
                )}
              </div>

              <div className="flex items-end gap-2 border-t border-border p-3">
                <textarea
                  value={unifiedInput}
                  onChange={(e) => setUnifiedInput(e.target.value)}
                  onKeyDown={handleUnifiedKeyDown}
                  placeholder="Unificado: 'hola', 'pagué 18k luz', 'llegó juan 8:30', '¿cuánto gasté hoy?'"
                  rows={1}
                  disabled={unifiedSending}
                  className="flex-1 resize-none rounded-xl border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
                />
                <Button size="sm" variant={recording ? 'destructive' : 'outline'} onClick={recording ? stopRecording : startRecording} disabled={unifiedSending} className="h-9 w-9 shrink-0 p-0" title={recording ? 'Detener grabación' : 'Grabar audio'}>
                  {recording ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                </Button>
                <Button size="sm" variant="outline" onClick={() => assistantFileInputRef.current?.click()} disabled={unifiedSending} className="h-9 w-9 shrink-0 p-0" title="Subir audio">
                  <Upload className="h-4 w-4" />
                </Button>
                <input ref={assistantFileInputRef} type="file" accept="audio/*" onChange={handleFileUpload} className="hidden" />
                <Button size="sm" variant="outline" onClick={() => unifiedVoucherInputRef.current?.click()} disabled={unifiedSending} className="h-9 w-9 shrink-0 p-0" title="Subir voucher (imagen/PDF) + caption">
                  <FileImage className="h-4 w-4" />
                </Button>
                <input ref={unifiedVoucherInputRef} type="file" accept="image/*,application/pdf" onChange={(e) => { const f = e.target.files?.[0]; if (f) setUnifiedVoucherFile(f); if (unifiedVoucherInputRef.current) unifiedVoucherInputRef.current.value = '' }} className="hidden" />
                <Button size="sm" onClick={() => { if (unifiedVoucherFile) { const f = unifiedVoucherFile; const nextTurns = [...unifiedTurns, { role: 'user' as const, content: `📎 ${f.name}` }]; setUnifiedTurns(nextTurns); const fd = new FormData(); fd.append('file', f); fd.append('caption', unifiedInput); fd.append('history', JSON.stringify(nextTurns.map((t) => ({ role: t.role, content: t.content })))); setUnifiedVoucherFile(null); const capText = unifiedInput; setUnifiedInput(''); setUnifiedSending(true); fetch('/api/bot-beta/unified', { method: 'POST', body: fd }).then(async (res) => { const result = await res.json(); if (!res.ok) { setUnifiedDebug(result); setUnifiedTurns([...nextTurns, { role: 'bot' as const, content: `Error: ${result.error || 'Error'}` }]); setUnifiedDebugTab('logs'); } else { setUnifiedDebug(result); const cap = result.caption ? `[caption: "${result.caption}"] ` : ''; setUnifiedTurns([...nextTurns, { role: 'bot' as const, content: `${cap}${result.reply}` }]); setUnifiedDebugTab('extraccion'); } }).catch((err) => setUnifiedTurns([...nextTurns, { role: 'bot' as const, content: `Error: ${err instanceof Error ? err.message : String(err)}` }])).finally(() => setUnifiedSending(false)); } else if (unifiedAudioBlob) { void sendUnifiedAudio(); } else { void sendUnifiedText(); } }} disabled={(!unifiedVoucherFile && !unifiedInput.trim() && !unifiedAudioBlob) || unifiedSending} className="h-9 w-9 shrink-0 p-0">
                  {unifiedSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </Button>
              </div>

              {unifiedVoucherFile && (
                <div className="flex items-center gap-2 border-t border-border px-3 py-2 bg-amber-500/10">
                  <FileImage className="h-4 w-4 text-amber-400 shrink-0" />
                  <span className="text-xs text-foreground truncate flex-1">{unifiedVoucherFile.name} ({(unifiedVoucherFile.size / 1024).toFixed(0)} KB){unifiedInput.trim() ? ` · caption: "${unifiedInput.trim().slice(0, 40)}"` : ' · sin caption (agregá nombre cliente)'}</span>
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setUnifiedVoucherFile(null)}>Quitar</Button>
                </div>
              )}
              {unifiedAudioBlob && (
                <div className="flex items-center gap-2 border-t border-border px-3 py-2 bg-muted/30">
                  <Volume2 className="h-4 w-4 text-muted-foreground shrink-0" />
                  <audio controls className="h-8 flex-1 min-w-0">
                    <source src={URL.createObjectURL(unifiedAudioBlob)} type={unifiedAudioBlob.type} />
                  </audio>
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setUnifiedAudioBlob(null)}>Cancelar</Button>
                </div>
              )}
            </div>

            {/* Columna derecha: Debug Unificado (4 tabs) */}
            <div className="flex w-1/2 flex-col rounded-xl border border-border bg-card">
              <div className="border-b border-border px-4 py-2 flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Debug — Unificado</span>
                {unifiedDebug?.dispatchedTo && <Badge variant="outline" className="text-[10px] bg-emerald-500/10 text-emerald-400 border-emerald-500/30">{unifiedDebug.dispatchedTo}</Badge>}
              </div>

              <Tabs value={unifiedDebugTab} onValueChange={setUnifiedDebugTab} className="flex flex-1 flex-col">
                <div className="border-b border-border px-3">
                  <TabsList className="h-9">
                    <TabsTrigger value="extraccion" className="text-xs gap-1.5"><Search className="h-3.5 w-3.5" /> Extracción</TabsTrigger>
                    <TabsTrigger value="tools" className="text-xs gap-1.5"><Wrench className="h-3.5 w-3.5" /> Tools</TabsTrigger>
                    <TabsTrigger value="respuesta" className="text-xs gap-1.5"><FileText className="h-3.5 w-3.5" /> Respuesta</TabsTrigger>
                    <TabsTrigger value="logs" className="text-xs gap-1.5"><List className="h-3.5 w-3.5" /> Logs</TabsTrigger>
                  </TabsList>
                </div>

                <TabsContent value="extraccion" className="flex-1 overflow-y-auto p-4 m-0">
                  {!unifiedDebug ? (
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground"><Search className="mr-2 h-5 w-5 opacity-50" />Enviá un mensaje.</div>
                  ) : (
                    <div className="space-y-3">
                      {unifiedDebug.transcription && <div className="rounded-lg border border-sky-500/20 bg-sky-500/5 p-3"><p className="text-xs font-medium text-sky-400 mb-1">Transcripción</p><p className="text-sm text-foreground">{unifiedDebug.transcription}</p></div>}
                      <div className="rounded-lg border border-border p-3"><p className="text-xs font-medium text-muted-foreground mb-1">UnifiedExtraction</p><pre className="text-[11px] text-foreground/80 font-mono whitespace-pre-wrap overflow-x-auto">{JSON.stringify(unifiedDebug.extraction, null, 2) || 'null'}</pre></div>
                      {unifiedDebug.extraction?.fallback_reason && <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-400" /><span className="text-xs text-foreground">Fallback: {unifiedDebug.extraction.fallback_reason} — {unifiedDebug.extraction.llm_error || ''}</span></div>}
                      {unifiedDebug.extraction?.jev_error && <div className="rounded-lg border border-rose-500/20 bg-rose-500/5 p-3"><p className="text-xs font-medium text-rose-400 mb-1">Jev (auxiliar) · error</p><pre className="text-[11px] font-mono">{unifiedDebug.extraction.jev_error}</pre></div>}
                      {unifiedDebug.extraction?.jev_intent != null && (
                        <div className="rounded-lg border border-violet-500/20 bg-violet-500/5 p-3">
                          <p className="text-xs font-medium text-violet-400 mb-1">Jev (auxiliar) · {unifiedDebug.extraction.jev_used ? 'en uso' : 'shadow'}</p>
                          <pre className="text-[11px] text-foreground/80 font-mono whitespace-pre-wrap">{`intent: ${unifiedDebug.extraction.jev_intent} (conf ${(unifiedDebug.extraction.jev_confidence ?? 0).toFixed(2)})\npending: ${unifiedDebug.extraction.jev_pending_domain ?? '—'} · answersPending=${(unifiedDebug.extraction.jev_answers_pending ?? 0).toFixed(2)} · supersedes=${(unifiedDebug.extraction.jev_supersedes ?? 0).toFixed(2)}`}</pre>
                        </div>
                      )}
                      <div className="rounded-lg border border-border p-3"><p className="text-xs font-medium text-muted-foreground mb-1">Router</p><pre className="text-[11px] font-mono">{unifiedDebug.dispatchedTo}:{unifiedDebug.dispatchReason} · dummy:{unifiedDebug.dummyConversationId?.slice(0, 8) || '—'}</pre></div>
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="tools" className="flex-1 overflow-y-auto p-4 m-0">
                  {!unifiedDebug ? (
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground"><Wrench className="mr-2 h-5 w-5 opacity-50" />Tools solo si factual.</div>
                  ) : (
                    <div className="space-y-3">
                      {unifiedDebug.toolLogs && unifiedDebug.toolLogs.length > 0 ? (
                        <div className="rounded-lg border border-border overflow-hidden">
                          <table className="w-full text-xs">
                            <thead className="bg-muted/50"><tr><th className="text-left px-3 py-1.5 font-medium text-muted-foreground">Tool</th><th className="text-right px-3 py-1.5 font-medium text-muted-foreground">Duración</th><th className="text-right px-3 py-1.5 font-medium text-muted-foreground">Count</th></tr></thead>
                            <tbody>{unifiedDebug.toolLogs.map((t, i) => (<tr key={i} className="border-t border-border"><td className="px-3 py-1.5 font-mono text-foreground">{t.tool}</td><td className="px-3 py-1.5 text-right font-mono text-muted-foreground">{t.duration_ms}ms</td><td className="px-3 py-1.5 text-right font-mono text-muted-foreground">{t.error ? <span className="text-red-400">{t.error.slice(0, 60)}</span> : (t.resultCount ?? '—')}</td></tr>))}</tbody>
                          </table>
                        </div>
                      ) : (
                        <div className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">No se ejecutaron tools (chitchat).</div>
                      )}
                      {unifiedDebug.toolResults && Object.keys(unifiedDebug.toolResults).length > 0 && <div className="rounded-lg border border-border p-3"><p className="text-xs font-medium text-muted-foreground mb-1">toolResults (preview)</p><pre className="text-[10px] text-foreground/70 font-mono whitespace-pre-wrap overflow-x-auto max-h-[400px]">{JSON.stringify(unifiedDebug.toolResults, null, 2).slice(0, 8000)}</pre></div>}
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="respuesta" className="flex-1 overflow-y-auto p-4 m-0">
                  {!unifiedDebug ? (
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground"><FileText className="mr-2 h-5 w-5 opacity-50" />Respuesta acá.</div>
                  ) : (
                    <div className="space-y-3">
                      <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3"><p className="text-xs font-medium text-emerald-400 mb-1">Reply</p><p className="text-sm text-foreground whitespace-pre-wrap">{unifiedDebug.reply}</p></div>
                      {unifiedDebug.knowledge.length > 0 && <div className="rounded-lg border border-border p-3"><p className="text-xs font-medium text-muted-foreground mb-1">Knowledge ({unifiedDebug.knowledge.length})</p>{unifiedDebug.knowledge.map((k, i) => (<p key={i} className="text-xs text-foreground/70 whitespace-pre-wrap border-b border-border py-1 last:border-0">{k.slice(0, 500)}</p>))}</div>}
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="logs" className="flex-1 overflow-y-auto p-4 m-0">
                  {!unifiedDebug || unifiedDebug.logs.length === 0 ? (
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground"><List className="mr-2 h-5 w-5 opacity-50" />Logs pipeline.</div>
                  ) : (
                    <div className="space-y-1.5">{unifiedDebug.logs.map((log, i) => { const meta = VOICE_STEP_LABELS[log.step] || { label: log.step, color: 'bg-muted text-muted-foreground border-border' }; return (<div key={i} className="rounded-lg border border-border p-2.5"><div className="flex items-center gap-2 flex-wrap"><Badge variant="outline" className={`text-[10px] ${meta.color}`}>{meta.label}</Badge></div><pre className="mt-1 text-[10px] text-foreground/70 font-mono whitespace-pre-wrap overflow-x-auto">{JSON.stringify(log.data, null, 2)}</pre></div>) })}</div>
                  )}
                </TabsContent>
              </Tabs>
            </div>
          </div>
        </TabsContent>

        {/* ─── Tab Asistente (legacy) ─── */}
        <TabsContent value="asistente" className="mt-4">
          <div className="flex gap-4" style={{ minHeight: '65vh' }}>
            {/* Columna izquierda: Chat Asistente */}
            <div className="flex w-1/2 flex-col rounded-xl border border-border bg-card">
              <div className="border-b border-border px-4 py-2">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Conversación — Asistente</span>
              </div>

              <div ref={assistantScrollRef} className="flex-1 space-y-4 overflow-y-auto p-4">
                {assistantTurns.length === 0 && (
                  <div className="flex h-full flex-col items-center justify-center text-center text-sm text-muted-foreground">
                    <Bot className="mb-2 h-8 w-8 text-muted-foreground/60" />
                    <p>¡Hola! Probá el asistente.</p>
                    <p className="mt-1 text-xs">Ej: &quot;hola&quot;, &quot;¿qué podés hacer?&quot;, &quot;pagué 18k luz&quot;, &quot;¿cuánto gasté hoy?&quot;, &quot;llegó juan 8:30&quot;</p>
                  </div>
                )}

                {assistantTurns.map((t, i) => (
                  <div key={i} className={cn('flex gap-2', t.role === 'user' ? 'justify-end' : 'justify-start')}>
                    {t.role === 'bot' && <Bot className="mt-1 h-5 w-5 shrink-0 text-primary" />}
                    <div
                      className={cn(
                        'max-w-[85%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap',
                        t.role === 'user' ? 'rounded-br-sm bg-primary text-primary-foreground' : 'rounded-bl-sm bg-muted text-foreground',
                      )}
                    >
                      {t.content}
                    </div>
                    {t.role === 'user' && <UserCircle2 className="mt-1 h-5 w-5 shrink-0 text-muted-foreground" />}
                  </div>
                ))}

                {assistantSending && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Bot className="h-5 w-5 text-primary" />
                    <Loader2 className="h-4 w-4 animate-spin" /> Procesando…
                  </div>
                )}
              </div>

              {/* Composer Asistente */}
              <div className="flex items-end gap-2 border-t border-border p-3">
                <textarea
                  value={assistantInput}
                  onChange={(e) => setAssistantInput(e.target.value)}
                  onKeyDown={handleAssistantKeyDown}
                  placeholder="Probá: 'hola', '¿qué podés hacer?', 'pagué 18k luz', '¿cuánto gasté hoy?', 'llegó juan 8:30'"
                  rows={1}
                  disabled={assistantSending}
                  className="flex-1 resize-none rounded-xl border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
                />
                <Button
                  size="sm"
                  variant={recording ? 'destructive' : 'outline'}
                  onClick={recording ? stopRecording : startRecording}
                  disabled={assistantSending}
                  className="h-9 w-9 shrink-0 p-0"
                  title={recording ? 'Detener grabación' : 'Grabar audio'}
                >
                  {recording ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => assistantFileInputRef.current?.click()}
                  disabled={assistantSending}
                  className="h-9 w-9 shrink-0 p-0"
                  title="Subir archivo de audio"
                >
                  <Upload className="h-4 w-4" />
                </Button>
                <input ref={assistantFileInputRef} type="file" accept="audio/*" onChange={handleFileUpload} className="hidden" />
                <Button
                  size="sm"
                  onClick={assistantAudioBlob ? sendAssistantAudio : sendAssistantText}
                  disabled={(!assistantInput.trim() && !assistantAudioBlob) || assistantSending}
                  className="h-9 w-9 shrink-0 p-0"
                >
                  {assistantSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </Button>
              </div>

              {assistantAudioBlob && (
                <div className="flex items-center gap-2 border-t border-border px-3 py-2 bg-muted/30">
                  <Volume2 className="h-4 w-4 text-muted-foreground shrink-0" />
                  <audio controls className="h-8 flex-1 min-w-0">
                    <source src={URL.createObjectURL(assistantAudioBlob)} type={assistantAudioBlob.type} />
                  </audio>
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setAssistantAudioBlob(null)}>
                    Cancelar
                  </Button>
                </div>
              )}
            </div>

            {/* Columna derecha: Debug Asistente (4 tabs) */}
            <div className="flex w-1/2 flex-col rounded-xl border border-border bg-card">
              <div className="border-b border-border px-4 py-2">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Debug — Asistente</span>
              </div>

              <Tabs value={assistantDebugTab} onValueChange={setAssistantDebugTab} className="flex flex-1 flex-col">
                <div className="border-b border-border px-3">
                  <TabsList className="h-9">
                    <TabsTrigger value="extraccion" className="text-xs gap-1.5">
                      <Search className="h-3.5 w-3.5" /> Extracción
                    </TabsTrigger>
                    <TabsTrigger value="tools" className="text-xs gap-1.5">
                      <Wrench className="h-3.5 w-3.5" /> Tools
                    </TabsTrigger>
                    <TabsTrigger value="respuesta" className="text-xs gap-1.5">
                      <FileText className="h-3.5 w-3.5" /> Respuesta
                    </TabsTrigger>
                    <TabsTrigger value="logs" className="text-xs gap-1.5">
                      <List className="h-3.5 w-3.5" /> Logs
                    </TabsTrigger>
                  </TabsList>
                </div>

                <TabsContent value="extraccion" className="flex-1 overflow-y-auto p-4 m-0">
                  {!assistantDebug ? (
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                      <Search className="mr-2 h-5 w-5 opacity-50" />
                      Enviá un mensaje para ver la extracción.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {assistantDebug.transcription && (
                        <div className="rounded-lg border border-sky-500/20 bg-sky-500/5 p-3">
                          <p className="text-xs font-medium text-sky-400 mb-1">Transcripción</p>
                          <p className="text-sm text-foreground">{assistantDebug.transcription}</p>
                        </div>
                      )}
                      <div className="rounded-lg border border-border p-3">
                        <p className="text-xs font-medium text-muted-foreground mb-1">UnifiedExtraction</p>
                        <pre className="text-[11px] text-foreground/80 font-mono whitespace-pre-wrap overflow-x-auto">
                          {JSON.stringify(assistantDebug.extraction, null, 2) || 'null'}
                        </pre>
                      </div>
                      {assistantDebug.extraction?.llm_raw && (
                        <div className="rounded-lg border border-border p-3">
                          <p className="text-xs font-medium text-muted-foreground mb-1">llm_raw</p>
                          <pre className="text-[10px] text-foreground/70 font-mono whitespace-pre-wrap overflow-x-auto">
                            {assistantDebug.extraction.llm_raw.slice(0, 3000)}
                          </pre>
                        </div>
                      )}
                      {assistantDebug.extraction?.fallback_reason && (
                        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 flex items-center gap-2">
                          <AlertTriangle className="h-4 w-4 text-amber-400" />
                          <span className="text-xs text-foreground">Fallback: {assistantDebug.extraction.fallback_reason} — {assistantDebug.extraction.llm_error || ''}</span>
                        </div>
                      )}
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="tools" className="flex-1 overflow-y-auto p-4 m-0">
                  {!assistantDebug ? (
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                      <Wrench className="mr-2 h-5 w-5 opacity-50" />
                      Los tools se ejecutan solo si el mensaje es factual.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {assistantDebug.toolLogs && assistantDebug.toolLogs.length > 0 ? (
                        <div className="rounded-lg border border-border overflow-hidden">
                          <table className="w-full text-xs">
                            <thead className="bg-muted/50">
                              <tr>
                                <th className="text-left px-3 py-1.5 font-medium text-muted-foreground">Tool</th>
                                <th className="text-right px-3 py-1.5 font-medium text-muted-foreground">Duración</th>
                                <th className="text-right px-3 py-1.5 font-medium text-muted-foreground">Count</th>
                              </tr>
                            </thead>
                            <tbody>
                              {assistantDebug.toolLogs.map((t, i) => (
                                <tr key={i} className="border-t border-border">
                                  <td className="px-3 py-1.5 font-mono text-foreground">{t.tool}</td>
                                  <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">{t.duration_ms}ms</td>
                                  <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">
                                    {t.error ? <span className="text-red-400">{t.error.slice(0, 60)}</span> : (t.resultCount ?? '—')}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <div className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
                          No se ejecutaron tools (chitchat o consulta sin keyword factual).
                        </div>
                      )}
                      {assistantDebug.toolResults && Object.keys(assistantDebug.toolResults).length > 0 && (
                        <div className="rounded-lg border border-border p-3">
                          <p className="text-xs font-medium text-muted-foreground mb-1">toolResults (preview)</p>
                          <pre className="text-[10px] text-foreground/70 font-mono whitespace-pre-wrap overflow-x-auto max-h-[400px]">
                            {JSON.stringify(assistantDebug.toolResults, null, 2).slice(0, 8000)}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="respuesta" className="flex-1 overflow-y-auto p-4 m-0">
                  {!assistantDebug ? (
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                      <FileText className="mr-2 h-5 w-5 opacity-50" />
                      La respuesta aparece acá.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
                        <p className="text-xs font-medium text-emerald-400 mb-1">Reply</p>
                        <p className="text-sm text-foreground whitespace-pre-wrap">{assistantDebug.reply}</p>
                      </div>
                      {assistantDebug.knowledge.length > 0 && (
                        <div className="rounded-lg border border-border p-3">
                          <p className="text-xs font-medium text-muted-foreground mb-1">Knowledge ({assistantDebug.knowledge.length})</p>
                          {assistantDebug.knowledge.map((k, i) => (
                            <p key={i} className="text-xs text-foreground/70 whitespace-pre-wrap border-b border-border py-1 last:border-0">
                              {k.slice(0, 500)}
                            </p>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="logs" className="flex-1 overflow-y-auto p-4 m-0">
                  {!assistantDebug || assistantDebug.logs.length === 0 ? (
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                      <List className="mr-2 h-5 w-5 opacity-50" />
                      Logs del pipeline del asistente.
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {assistantDebug.logs.map((log, i) => {
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
                </TabsContent>
              </Tabs>
            </div>
          </div>
        </TabsContent>

        {/* ─── Tab Vouchers (copy aislada dryRun) ─── */}
        <TabsContent value="vouchers" className="mt-4">
          <div className="flex gap-4" style={{ minHeight: '65vh' }}>
            {/* Izquierda: Chat Vouchers */}
            <div className="flex w-1/2 flex-col rounded-xl border border-border bg-card">
              <div className="border-b border-border px-4 py-2 flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Conversación — Vouchers</span>
                <Badge variant="outline" className="text-[10px] bg-amber-500/10 text-amber-500 border-amber-500/30">DRYRUN</Badge>
              </div>
              <div ref={voucherScrollRef} className="flex-1 space-y-4 overflow-y-auto p-4">
                {voucherTurns.length === 0 && (
                  <div className="flex h-full flex-col items-center justify-center text-center text-sm text-muted-foreground">
                    <Receipt className="mb-2 h-8 w-8 text-muted-foreground/60" />
                    <p>Probá voucher sin escribir en producción.</p>
                    <p className="mt-1 text-xs">Texto: &quot;Tobi pagó $12.000 en efectivo&quot; o subí imagen/PDF de transferencia.</p>
                    <p className="mt-1 text-[11px] text-amber-500">🔒 Copia aislada — mismo pool 1-5 prod, sin crear voucher_reviews ni pagos.</p>
                  </div>
                )}
                {voucherTurns.map((t, i) => (
                  <div key={i} className={cn('flex gap-2', t.role === 'user' ? 'justify-end' : 'justify-start')}>
                    {t.role === 'bot' && <Bot className="mt-1 h-5 w-5 shrink-0 text-primary" />}
                    <div className={cn('max-w-[85%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap', t.role === 'user' ? 'rounded-br-sm bg-primary text-primary-foreground' : 'rounded-bl-sm bg-muted text-foreground')}>{t.content}</div>
                    {t.role === 'user' && <UserCircle2 className="mt-1 h-5 w-5 shrink-0 text-muted-foreground" />}
                  </div>
                ))}
                {voucherSending && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Bot className="h-5 w-5 text-primary" />
                    <Loader2 className="h-4 w-4 animate-spin" /> Procesando voucher…
                  </div>
                )}
              </div>
              <div className="flex items-end gap-2 border-t border-border p-3">
                <textarea value={voucherInput} onChange={(e) => setVoucherInput(e.target.value)} onKeyDown={handleVoucherKeyDown} placeholder="Ej: Tobi pagó 12000 en efectivo o pegá respuesta A/B" rows={1} disabled={voucherSending} className="flex-1 resize-none rounded-xl border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50" />
                <Button size="sm" variant="outline" onClick={() => voucherFileInputRef.current?.click()} disabled={voucherSending} className="h-9 w-9 shrink-0 p-0" title="Subir comprobante">
                  <FileImage className="h-4 w-4" />
                </Button>
                <input ref={voucherFileInputRef} type="file" accept="image/*,application/pdf" onChange={handleVoucherFile} className="hidden" />
                <Button size="sm" onClick={voucherFile ? sendVoucherFile : sendVoucherText} disabled={(!voucherInput.trim() && !voucherFile) || voucherSending} className="h-9 w-9 shrink-0 p-0">
                  {voucherSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </Button>
              </div>
              {voucherFile && (
                <div className="flex items-center gap-2 border-t border-border px-3 py-2 bg-muted/30">
                  <FileImage className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="flex-1 min-w-0 truncate text-xs text-foreground">{voucherFile.name} ({(voucherFile.size / 1024).toFixed(0)} KB)</span>
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setVoucherFile(null)}>Cancelar</Button>
                  <Button size="sm" className="h-7 text-xs" onClick={sendVoucherFile} disabled={voucherSending}>Enviar</Button>
                </div>
              )}
            </div>
            {/* Derecha: Debug Vouchers */}
            <div className="flex w-1/2 flex-col rounded-xl border border-border bg-card">
              <div className="border-b border-border px-4 py-2">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Debug — Vouchers (dryRun)</span>
              </div>
              <Tabs value={voucherDebugTab} onValueChange={setVoucherDebugTab} className="flex flex-1 flex-col">
                <div className="border-b border-border px-3">
                  <TabsList className="h-9">
                    <TabsTrigger value="extraccion" className="text-xs gap-1.5"><Search className="h-3.5 w-3.5" /> Extracción</TabsTrigger>
                    <TabsTrigger value="candidatas" className="text-xs gap-1.5"><Receipt className="h-3.5 w-3.5" /> Candidatas</TabsTrigger>
                    <TabsTrigger value="phases" className="text-xs gap-1.5"><Wrench className="h-3.5 w-3.5" /> Phases</TabsTrigger>
                    <TabsTrigger value="raw" className="text-xs gap-1.5"><List className="h-3.5 w-3.5" /> Raw</TabsTrigger>
                  </TabsList>
                </div>
                <TabsContent value="extraccion" className="flex-1 overflow-y-auto p-4 m-0">
                  {!voucherDebug ? (
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground"><Search className="mr-2 h-5 w-5 opacity-50" />Enviá texto o imagen para ver extracción.</div>
                  ) : (
                    <div className="space-y-3">
                      <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-2 text-xs text-amber-600">{voucherDebug.banner}</div>
                      <div className="rounded-lg border border-border p-3">
                        <p className="text-xs font-medium text-muted-foreground mb-1">Extracción</p>
                        <pre className="text-[11px] font-mono whitespace-pre-wrap overflow-x-auto">{JSON.stringify(voucherDebug.extraction, null, 2)}</pre>
                      </div>
                      <div className="rounded-lg border border-border p-3">
                        <p className="text-xs font-medium text-muted-foreground mb-1">Mensaje</p>
                        <p className="text-sm whitespace-pre-wrap">{voucherDebug.mensajeRespuesta}</p>
                        <p className="mt-1 text-xs">Status: <Badge variant="outline" className="text-[10px]">{voucherDebug.matchStatus}</Badge> {voucherDebug.matchedInvoiceNumero ? `→ ${voucherDebug.matchedClienteNombre} ${voucherDebug.matchedInvoiceNumero}` : ''}</p>
                      </div>
                    </div>
                  )}
                </TabsContent>
                <TabsContent value="candidatas" className="flex-1 overflow-y-auto p-4 m-0">
                  {!voucherDebug || voucherDebug.candidates.length === 0 ? (
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground"><Receipt className="mr-2 h-5 w-5 opacity-50" />Sin candidatas (o pool vacío).</div>
                  ) : (
                    <div className="space-y-2">
                      {voucherDebug.candidates.map((c, i) => (
                        <div key={i} className="rounded-lg border border-border p-2.5 flex items-center justify-between">
                          <div>
                            <p className="text-xs font-medium">{String.fromCharCode(65 + i)}. {c.cliente_nombre} — {c.numero_factura}</p>
                            <p className="text-[11px] text-muted-foreground">Saldo: ${c.saldo_pendiente?.toLocaleString('es-AR')} {c.score != null ? `· score ${c.score.toFixed(3)}` : ''}</p>
                          </div>
                          <Badge variant="outline" className="text-[10px]">ID {c.invoice_id}</Badge>
                        </div>
                      ))}
                      {voucherDebug.matchStatus === 'matched' && <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-2 text-xs">🔒 Se registraría {voucherDebug.matchedClienteNombre} FAC {voucherDebug.matchedInvoiceNumero} — NO escrito (dryRun)</div>}
                    </div>
                  )}
                </TabsContent>
                <TabsContent value="phases" className="flex-1 overflow-y-auto p-4 m-0">
                  {!voucherDebug ? (
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground"><Wrench className="mr-2 h-5 w-5 opacity-50" />Fases 1-5 idénticas a prod.</div>
                  ) : (
                    <div className="space-y-2">
                      {(["phase1","phase2","phase3","phase4","phase5","decision"] as const).map((k) => {
                        const v = (voucherDebug.debugInfo as Record<string, unknown>)[k]
                        if (!v) return null
                        return (
                          <div key={k} className="rounded-lg border border-border p-2.5">
                            <p className="text-xs font-medium text-muted-foreground mb-1">{k}</p>
                            <pre className="text-[10px] font-mono whitespace-pre-wrap overflow-x-auto max-h-[200px]">{JSON.stringify(v, null, 2)}</pre>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </TabsContent>
                <TabsContent value="raw" className="flex-1 overflow-y-auto p-4 m-0">
                  {!voucherDebug ? (
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground"><List className="mr-2 h-5 w-5 opacity-50" />Raw JSON</div>
                  ) : (
                    <pre className="text-[10px] font-mono whitespace-pre-wrap overflow-x-auto">{JSON.stringify(voucherDebug, null, 2)}</pre>
                  )}
                </TabsContent>
              </Tabs>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
