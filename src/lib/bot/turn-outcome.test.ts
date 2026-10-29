import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  assistantOutcomeToStatus,
  buildFallbackContext,
  buildRetryContext,
  getFallbackDomains,
  isDeadEndReply,
  isRetryWorthy,
  isStrongIntentForRetry,
  parseLastTurn,
  shouldFallback,
  shouldTakeoverRetry,
  type LastTurn,
} from './turn-outcome'

const NOW = Date.parse('2026-10-29T12:00:00.000Z')

function turn(overrides: Partial<LastTurn> = {}): LastTurn {
  return {
    messageId: 'wamid.1',
    text: 'gasté 5000 en luz',
    domain: 'expense',
    reason: 'intent',
    status: 'declined',
    at: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('isDeadEndReply', () => {
  it('detecta los callejones sin salida típicos', () => {
    expect(isDeadEndReply('No te entendí 🤔 ¿me repetís?')).toBe(true)
    expect(isDeadEndReply('No pude identificar el producto para cotizar.')).toBe(true)
    expect(isDeadEndReply('Sigo sin entender el monto. Escribí solo el número (ej: 5000).')).toBe(true)
    expect(isDeadEndReply('No se pudo guardar el gasto.')).toBe(true)
    expect(isDeadEndReply('No se detectaron ítems para cotizar.')).toBe(true)
  })

  it('no marca respuestas útiles ni el follow-up de voucher', () => {
    expect(isDeadEndReply('Listo, registré el gasto ✅')).toBe(false)
    expect(isDeadEndReply('No encontré facturas para Ale. Pasame el monto.')).toBe(false)
    expect(isDeadEndReply('')).toBe(false)
    expect(isDeadEndReply(null)).toBe(false)
  })
})

describe('parseLastTurn', () => {
  it('devuelve null para shapes inválidos', () => {
    expect(parseLastTurn(null)).toBeNull()
    expect(parseLastTurn({})).toBeNull()
    expect(parseLastTurn({ messageId: 'x', text: 'hola' })).toBeNull()
  })

  it('normaliza campos opcionales', () => {
    const parsed = parseLastTurn({
      messageId: 'm',
      text: 'hola',
      status: 'declined',
      at: new Date(NOW).toISOString(),
    })
    expect(parsed).toMatchObject({ domain: 'unknown', reason: '', fallbackFrom: null })
  })
})

describe('isRetryWorthy', () => {
  it('acepta estados fallidos dentro del TTL', () => {
    for (const status of ['declined', 'no_reply', 'error', 'replied_dead_end'] as const) {
      expect(isRetryWorthy(turn({ status }), NOW)).toBe(true)
    }
  })

  it('rechaza turnos respondidos, en proceso o viejos', () => {
    expect(isRetryWorthy(turn({ status: 'replied' }), NOW)).toBe(false)
    expect(isRetryWorthy(turn({ status: 'fallback_replied' }), NOW)).toBe(false)
    expect(isRetryWorthy(turn({ status: 'processing' }), NOW)).toBe(false)
    expect(isRetryWorthy(turn({ at: new Date(NOW - 60 * 60 * 1000).toISOString() }), NOW)).toBe(false)
    expect(isRetryWorthy(turn({ at: new Date(NOW + 60_000).toISOString() }), NOW)).toBe(false)
    expect(isRetryWorthy(null, NOW)).toBe(false)
  })
})

describe('getFallbackDomains', () => {
  it('sin env = expense + attendance (fase 1 activa)', () => {
    const prev = process.env.ASSISTANT_FALLBACK_DOMAINS
    delete process.env.ASSISTANT_FALLBACK_DOMAINS
    try {
      expect([...getFallbackDomains()]).toEqual(['expense', 'attendance'])
    } finally {
      if (prev !== undefined) process.env.ASSISTANT_FALLBACK_DOMAINS = prev
    }
  })

  it('vacío u off = apagado', () => {
    vi.stubEnv('ASSISTANT_FALLBACK_DOMAINS', '')
    expect(getFallbackDomains().size).toBe(0)
    vi.stubEnv('ASSISTANT_FALLBACK_DOMAINS', 'off')
    expect(getFallbackDomains().size).toBe(0)
  })

  it('filtra dominios desconocidos y normaliza', () => {
    vi.stubEnv('ASSISTANT_FALLBACK_DOMAINS', ' Expense, attendance ,voucher')
    expect([...getFallbackDomains()]).toEqual(['expense', 'attendance'])
  })
})

describe('shouldFallback', () => {
  it('solo cuando el dominio está habilitado y no hubo respuesta', () => {
    const enabled = new Set(['expense'])
    expect(shouldFallback({ domain: 'expense', replied: false, enabled })).toBe(true)
    expect(shouldFallback({ domain: 'expense', replied: true, enabled })).toBe(false)
    expect(shouldFallback({ domain: 'attendance', replied: false, enabled })).toBe(false)
  })

  it('no dispara si el handler ya escribió (anti-duplicado)', () => {
    const enabled = new Set(['expense'])
    expect(shouldFallback({ domain: 'expense', replied: false, wrote: true, enabled })).toBe(false)
    expect(shouldFallback({ domain: 'expense', replied: false, wrote: false, enabled })).toBe(true)
  })

  it('fase 1: expense/attendance activos por defecto, pedido no', () => {
    const prev = process.env.ASSISTANT_FALLBACK_DOMAINS
    delete process.env.ASSISTANT_FALLBACK_DOMAINS
    try {
      expect(shouldFallback({ domain: 'expense', replied: false })).toBe(true)
      expect(shouldFallback({ domain: 'attendance', replied: false })).toBe(true)
      expect(shouldFallback({ domain: 'pedido', replied: false })).toBe(false)
    } finally {
      if (prev !== undefined) process.env.ASSISTANT_FALLBACK_DOMAINS = prev
    }
  })
})

describe('shouldTakeoverRetry', () => {
  const base = {
    last: turn(),
    botAllowed: true,
    hasPending: false,
    strongNewIntent: false,
    clarifyHandled: false,
    now: NOW,
  }

  it('toma el reintento cuando no hay pendientes ni intent fuerte', () => {
    expect(shouldTakeoverRetry(base)).toBe(true)
  })

  it('no secuestra pendientes, clarify, intent fuerte ni números no autorizados', () => {
    expect(shouldTakeoverRetry({ ...base, hasPending: true })).toBe(false)
    expect(shouldTakeoverRetry({ ...base, clarifyHandled: true })).toBe(false)
    expect(shouldTakeoverRetry({ ...base, strongNewIntent: true })).toBe(false)
    expect(shouldTakeoverRetry({ ...base, botAllowed: false })).toBe(false)
  })
})

describe('isStrongIntentForRetry', () => {
  it('solo intents de dominio con confianza alta/media', () => {
    expect(isStrongIntentForRetry({ intent: 'gasto', confianza: 'alta' } as never)).toBe(true)
    expect(isStrongIntentForRetry({ intent: 'gasto', confianza: 'baja' } as never)).toBe(false)
    expect(isStrongIntentForRetry({ intent: 'otro', confianza: 'alta' } as never)).toBe(false)
    expect(isStrongIntentForRetry(null)).toBe(false)
  })
})

describe('contextos', () => {
  it('el reintento incluye el mensaje y dominio anterior', () => {
    const ctx = buildRetryContext(turn())
    expect(ctx).toContain('gasté 5000 en luz')
    expect(ctx).toContain('expense')
    expect(ctx).toContain('reintentando')
  })

  it('el fallback del mismo turno no dice "reintentando"', () => {
    const ctx = buildFallbackContext({
      text: 'ponele 5000',
      domain: 'expense',
      outcome: { handled: false, replied: false },
    })
    expect(ctx).toContain('NO PUDO RESOLVER')
    expect(ctx).not.toContain('reintentando')
  })
})

describe('assistantOutcomeToStatus', () => {
  it('mapea los desenlaces del agente', () => {
    expect(assistantOutcomeToStatus('replied')).toBe('replied')
    expect(assistantOutcomeToStatus('empty')).toBe('no_reply')
    expect(assistantOutcomeToStatus('blocked')).toBe('blocked')
    expect(assistantOutcomeToStatus('error')).toBe('error')
  })
})
