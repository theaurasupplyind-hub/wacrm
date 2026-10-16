import { describe, it, expect, vi, beforeEach } from 'vitest'

const sent = vi.hoisted(() => ({ texts: [] as string[] }))

vi.mock('@/lib/flows/meta-send', () => ({
  engineSendText: vi.fn(async (a: { text: string }) => {
    sent.texts.push(a.text)
    return { whatsapp_message_id: 'x' }
  }),
  engineSendInteractiveButtons: vi.fn(async () => ({ whatsapp_message_id: 'x' })),
}))

vi.mock('@/lib/facbal/client', () => ({
  updateExpense: vi.fn(async () => ({})),
}))

vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: vi.fn(),
  downloadMedia: vi.fn(),
}))

vi.mock('@/lib/ai/openrouter', () => ({ callOpenRouter: vi.fn() }))

import { processExpenseMessage } from './index'

interface DbState {
  expense: unknown
}

function makeDb(state: DbState) {
  const db = {
    from() {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: { expense_context: state.expense } }) }),
        }),
        update: (vals: Record<string, unknown>) => ({
          eq: async () => {
            state.expense = vals.expense_context
            return { error: null }
          },
        }),
        insert: async () => ({ error: null }),
      }
    },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Object.assign(db as any, { getExpense: () => state.expense })
}

function args(db: ReturnType<typeof makeDb>, text: string) {
  return {
    db,
    messageType: 'text' as const,
    text,
    accessToken: 'tok',
    senderPhone: '5491100000000',
    senderName: 'Juan',
    accountId: 'acc',
    userId: 'u',
    conversationId: 'conv',
    contactId: '1',
  }
}

describe('escape del flujo de gastos (missingField amount)', () => {
  let state: DbState

  beforeEach(() => {
    sent.texts = []
    state = {
      expense: {
        stage: 'collecting',
        pendingExpense: {
          amount: null,
          description: 'algo',
          category: null,
          provider: null,
          employee: null,
          payment_method: null,
          reference: null,
          date: '2026-10-16',
          isExpenseIntent: true,
          raw: 'algo',
        },
        missingField: 'amount',
      },
    }
  })

  it('"que estas haciendo" limpia el contexto y sale del flujo (no repite el monto)', async () => {
    const db = makeDb(state)
    const result = await processExpenseMessage(args(db, 'que estas haciendo'))

    expect(result.handled).toBe(true)
    expect(sent.texts.at(-1)).toContain('cancelé el registro de gasto')
    expect(sent.texts.at(-1)).not.toContain('Sigo sin entender')
    expect((db.getExpense() as Record<string, unknown>).pendingExpense).toBeUndefined()
    expect((db.getExpense() as Record<string, unknown>).missingField).toBeUndefined()
  })

  it('"cancelar" también escapa del flujo de gastos', async () => {
    const db = makeDb(state)
    await processExpenseMessage(args(db, 'cancelar'))
    expect(sent.texts.at(-1)).toContain('cancelé el registro de gasto')
    expect((db.getExpense() as Record<string, unknown>).pendingExpense).toBeUndefined()
  })
})
