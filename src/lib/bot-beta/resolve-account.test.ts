import { describe, it, expect } from 'vitest'
import { resolveBetaAccountId } from './unified-handler'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stubDb(accountId: string | null, throws = false): any {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          limit: () => ({
            maybeSingle: async () => {
              if (throws) throw new Error('RLS denied')
              return { data: accountId ? { account_id: accountId } : null }
            },
          }),
        }),
      }),
    }),
  }
}

describe('resolveBetaAccountId', () => {
  it('usa el cliente autenticado cuando funciona', async () => {
    const id = await resolveBetaAccountId({ supabase: stubDb('acc-1'), admin: stubDb('acc-2'), userId: 'u' })
    expect(id).toBe('acc-1')
  })

  it('cae a service-role si RLS bloquea (acotado al user_id)', async () => {
    const id = await resolveBetaAccountId({ supabase: stubDb(null, true), admin: stubDb('acc-2'), userId: 'u' })
    expect(id).toBe('acc-2')
  })

  it('null si no hay membresía en ningún lado', async () => {
    const id = await resolveBetaAccountId({ supabase: stubDb(null), admin: stubDb(null), userId: 'u' })
    expect(id).toBeNull()
  })
})
