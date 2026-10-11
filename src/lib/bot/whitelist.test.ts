import { afterEach, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { isPhoneAllowed, isWhitelistEnforced } from './whitelist'

// Minimal SupabaseClient stub: resolves the .from().select().eq()...maybeSingle()
// chain to a fixed result.
function stubDb(result: { data: unknown; error: unknown }): SupabaseClient {
  const builder = {
    select: () => builder,
    eq: () => builder,
    limit: () => builder,
    maybeSingle: () => Promise.resolve(result),
  }
  return { from: () => builder } as unknown as SupabaseClient
}

afterEach(() => {
  delete process.env.BOT_WHITELIST_ENFORCED
})

describe('isPhoneAllowed', () => {
  it('permite un número presente en la whitelist', async () => {
    const db = stubDb({ data: { id: 1 }, error: null })
    expect(await isPhoneAllowed(db, 'acct', '+54 9 11 3000-0000')).toBe(true)
  })

  it('deniega un número ausente', async () => {
    const db = stubDb({ data: null, error: null })
    expect(await isPhoneAllowed(db, 'acct', '5491130000000')).toBe(false)
  })

  it('deniega un teléfono vacío sin consultar', async () => {
    const db = stubDb({ data: { id: 1 }, error: null })
    expect(await isPhoneAllowed(db, 'acct', '   ')).toBe(false)
  })

  it('fail-open si la tabla no existe (no apaga el bot)', async () => {
    const db = stubDb({
      data: null,
      error: { message: 'relation "bot_allowed_numbers" does not exist' },
    })
    expect(await isPhoneAllowed(db, 'acct', '5491130000000')).toBe(true)
  })

  it('fail-open ante un error de infra', async () => {
    const db = stubDb({ data: null, error: { message: 'connection reset' } })
    expect(await isPhoneAllowed(db, 'acct', '5491130000000')).toBe(true)
  })
})

describe('isWhitelistEnforced', () => {
  it('está activo por defecto', () => {
    expect(isWhitelistEnforced()).toBe(true)
  })

  it('se desactiva con BOT_WHITELIST_ENFORCED=false (kill switch)', () => {
    process.env.BOT_WHITELIST_ENFORCED = 'false'
    expect(isWhitelistEnforced()).toBe(false)
  })

  it('kill switch deja pasar a cualquiera', async () => {
    process.env.BOT_WHITELIST_ENFORCED = 'false'
    const db = stubDb({ data: null, error: null })
    expect(await isPhoneAllowed(db, 'acct', '5491130000000')).toBe(true)
  })
})
