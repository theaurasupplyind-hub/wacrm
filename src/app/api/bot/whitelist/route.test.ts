import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Tests de la whitelist del bot: normalización en el POST, gating admin y
// CRUD. Se mockea `@/lib/supabase/server` para que getCurrentAccount/requireRole
// resuelvan sin red (mismo patrón que api/whatsapp/send/route.test.ts).
// ---------------------------------------------------------------------------

let role: 'owner' | 'viewer' = 'owner'
let tableRows: Record<string, unknown[]> = {}
const upsertCalls: Array<{ table: string; payload: unknown }> = []

function makeSupabaseMock() {
  function builder(table: string) {
    const b: Record<string, unknown> = {}
    const chain = () => b
    for (const m of ['select', 'eq', 'in', 'order', 'limit', 'update', 'delete']) {
      b[m] = vi.fn(chain)
    }
    b.upsert = vi.fn((payload: unknown) => {
      upsertCalls.push({ table, payload })
      const arr = Array.isArray(payload) ? payload : [payload]
      const data = arr.map((r, i) => ({
        id: i + 1,
        active: true,
        label: null,
        created_at: '2026-01-01T00:00:00Z',
        ...(r as object),
      }))
      return { select: () => Promise.resolve({ data, error: null }) }
    })
    const rowsFor = () => {
      if (table === 'profiles') {
        return { data: { account_id: 'acct-1', account_role: role }, error: null }
      }
      if (table === 'accounts') {
        return { data: { id: 'acct-1', name: 'Acct' }, error: null }
      }
      return { data: tableRows[table] ?? [], error: null }
    }
    const single = () => {
      const r = rowsFor()
      return Promise.resolve({
        data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data,
        error: r.error,
      })
    }
    b.maybeSingle = vi.fn(single)
    b.single = vi.fn(single)
    b.then = (resolve: (v: unknown) => unknown) => resolve(rowsFor())
    return b
  }
  return {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })),
    },
    from: vi.fn((t: string) => builder(t)),
  }
}

let supabaseMock = makeSupabaseMock()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => supabaseMock),
}))

import { GET, POST } from './route'
import { PATCH, DELETE } from './[id]/route'

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/bot/whitelist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

function params(id: string) {
  return { params: Promise.resolve({ id }) }
}

describe('bot whitelist API', () => {
  beforeEach(() => {
    role = 'owner'
    tableRows = {}
    upsertCalls.length = 0
    supabaseMock = makeSupabaseMock()
  })

  it('GET lista los números de la cuenta', async () => {
    tableRows['bot_allowed_numbers'] = [
      { id: 1, phone: '5491125491605', label: 'Jesús', active: true, created_at: 'x' },
    ]
    const res = await GET()
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.numbers).toHaveLength(1)
  })

  it('POST normaliza a solo dígitos y hace upsert', async () => {
    const res = await post({ phone: '+54 9 11 2549-1605', label: 'Jesús' })
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.numbers[0]).toMatchObject({
      account_id: 'acct-1',
      phone: '5491125491605',
      label: 'Jesús',
      active: true,
    })
    expect(upsertCalls).toHaveLength(1)
    expect(upsertCalls[0].payload).toEqual([
      { account_id: 'acct-1', phone: '5491125491605', active: true, label: 'Jesús' },
    ])
  })

  it('POST bulk normaliza y deduplica', async () => {
    const res = await post({ phones: ['5491125491605', '+54 9 11 2549-1605', '123'] })
    expect(res.status).toBe(200)
    const payload = upsertCalls[0].payload as unknown[]
    expect(payload).toHaveLength(1)
  })

  it('POST sin teléfonos válidos → 400', async () => {
    const res = await post({ phone: '123' })
    expect(res.status).toBe(400)
  })

  it('POST sin rol admin → 403', async () => {
    role = 'viewer'
    const res = await post({ phone: '5491125491605' })
    expect(res.status).toBe(403)
  })

  it('PATCH actualiza y devuelve la fila', async () => {
    tableRows['bot_allowed_numbers'] = [
      { id: 1, phone: '5491125491605', label: null, active: true, created_at: 'x' },
    ]
    const res = await PATCH(
      new Request('http://localhost/api/bot/whitelist/1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: false }),
      }),
      params('1'),
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.number).toMatchObject({ id: 1 })
  })

  it('PATCH con id inválido → 400', async () => {
    const res = await PATCH(
      new Request('http://localhost/api/bot/whitelist/abc', { method: 'PATCH' }),
      params('abc'),
    )
    expect(res.status).toBe(400)
  })

  it('DELETE borra la fila', async () => {
    const res = await DELETE(
      new Request('http://localhost/api/bot/whitelist/1', { method: 'DELETE' }),
      params('1'),
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
  })

  it('DELETE sin rol admin → 403', async () => {
    role = 'viewer'
    const res = await DELETE(
      new Request('http://localhost/api/bot/whitelist/1', { method: 'DELETE' }),
      params('1'),
    )
    expect(res.status).toBe(403)
  })
})
