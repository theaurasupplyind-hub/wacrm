import { describe, it, expect } from 'vitest'
import { buildBotTrace } from './build-trace'
import { mergeBotTraces } from './merge'
import { BotTraceSchema, parseBotTrace, rowToBotTrace } from './schema'
import { BOT_TOPOLOGY, topologyIsConsistent, dispatchNodeId } from './topology'

describe('topology', () => {
  it('todas las aristas apuntan a nodos existentes', () => {
    expect(topologyIsConsistent()).toBe(true)
  })

  it('no hay ids de nodo duplicados', () => {
    const ids = BOT_TOPOLOGY.nodes.map((n) => n.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('mapea dispatched_to a su nodo de dispatch', () => {
    expect(dispatchNodeId('voucher')).toBe('d_voucher')
    expect(dispatchNodeId('assistant')).toBe('d_assistant')
    expect(dispatchNodeId('none')).toBe('d_none')
    expect(dispatchNodeId(null)).toBeNull()
  })
})

describe('buildBotTrace', () => {
  it('arma path y steps para un mensaje de texto ruteado a assistant', () => {
    const trace = buildBotTrace({
      messageId: 'm1',
      producer: 'webhook',
      source: 'text',
      rawText: 'Hola',
      extraction: { intent: 'otro', confianza: 'baja', extractor_source: 'llm' },
      dispatchedTo: 'assistant',
      dispatchReason: 'intent',
      finalStatus: 'assistant',
    })
    expect(trace.path).toContain('webhook')
    expect(trace.path).toContain('extract')
    expect(trace.path).toContain('router')
    expect(trace.path).toContain('d_assistant')
    expect(trace.path).toContain('h_assistant')
    expect(trace.steps.some((s) => s.nodeId === 'extract')).toBe(true)
    // ids prefijados por productor (para el merge append-only)
    expect(trace.steps.every((s) => s.id.startsWith('webhook:'))).toBe(true)
  })

  it('un voucher con debugInfo agrega el nodo de pipeline', () => {
    const trace = buildBotTrace({
      messageId: 'm2',
      producer: 'voucher',
      source: 'voucher',
      voucherDebug: { phase1: { ok: true } },
      voucherStatus: 'matched',
    })
    expect(trace.path).toContain('h_voucher_media')
    expect(trace.path).toContain('t_matched')
    expect(trace.status).toBe('matched')
  })
})

describe('mergeBotTraces', () => {
  const base = buildBotTrace({
    messageId: 'm3',
    producer: 'webhook',
    source: 'image',
    rawText: 'voucher',
    dispatchedTo: 'voucher',
    dispatchReason: 'intent',
  })
  const incoming = buildBotTrace({
    messageId: 'm3',
    producer: 'voucher',
    source: 'voucher',
    voucherDebug: { phase1: {} },
    voucherStatus: 'matched',
    finalStatus: 'matched',
  })

  it('une paths sin duplicar y conserva steps de ambos', () => {
    const merged = mergeBotTraces(base, incoming)
    expect(new Set(merged.path).size).toBe(merged.path.length)
    expect(merged.path).toContain('t_matched')
    expect(merged.steps.some((s) => s.id.startsWith('voucher:'))).toBe(true)
    expect(merged.steps.some((s) => s.id.startsWith('webhook:'))).toBe(true)
  })

  it('gana el status de mayor prioridad', () => {
    const merged = mergeBotTraces(base, incoming)
    expect(merged.status).toBe('matched')
  })

  it('no pisa steps existentes ante colisión de id', () => {
    const a = { ...base, steps: [{ ...base.steps[0], id: 'x', label: 'primero' }] }
    const b = { ...incoming, steps: [{ ...incoming.steps[0], id: 'x', label: 'segundo' }] }
    const merged = mergeBotTraces(a, b)
    expect(merged.steps.find((s) => s.id === 'x')?.label).toBe('primero')
  })
})

describe('schema', () => {
  it('parseBotTrace acepta una traza válida', () => {
    const trace = buildBotTrace({ messageId: 'm4', rawText: 'x', dispatchedTo: 'none' })
    expect(parseBotTrace(trace)?.messageId).toBe('m4')
  })

  it('parseBotTrace devuelve null para basura', () => {
    expect(parseBotTrace({ foo: 'bar' })).toBeNull()
  })

  it('rowToBotTrace mapea snake_case de Supabase', () => {
    const row = {
      message_id: 'm5',
      conversation_id: null,
      status: 'matched',
      path: ['webhook'],
      steps: [],
      raw_text: 'hola',
    }
    const trace = rowToBotTrace(row)
    expect(trace?.messageId).toBe('m5')
    expect(trace?.status).toBe('matched')
    expect(BotTraceSchema.safeParse(trace).success).toBe(true)
  })
})
