import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { normalizeTerm, type GlossaryMeaning } from '@/lib/pedidos/glossary'

/**
 * GET    /api/order-glossary            — lista el glosario de la cuenta.
 * POST   /api/order-glossary            — crea/actualiza un término (admin+).
 *          body: { term, type: 'grosor'|'alias', value: number|string }
 * DELETE /api/order-glossary?id=…|term=… — borra un término (admin+).
 *
 * El glosario se aprende solo cuando el bot pregunta un término desconocido;
 * esta API es para revisarlo/administrarlo. Ver migración 051.
 */

const TABLE = 'order_glossary'

function missingTable(error: { message?: string } | null): boolean {
  const msg = error?.message ?? ''
  return msg.includes('relation') && msg.includes('does not exist')
}

function tableMissingResponse() {
  return NextResponse.json(
    {
      error:
        'La tabla order_glossary no existe. Ejecutá la migración 051_order_glossary.sql en Supabase.',
    },
    { status: 503 },
  )
}

function buildMeaning(body: Record<string, unknown> | null): GlossaryMeaning | null {
  if (!body) return null
  if (body.type === 'grosor') {
    const n = typeof body.value === 'number' ? body.value : parseFloat(String(body.value ?? '').replace(',', '.'))
    return Number.isFinite(n) && n > 0 ? { type: 'grosor', value: n } : null
  }
  if (body.type === 'alias' && typeof body.value === 'string' && body.value.trim()) {
    return { type: 'alias', value: body.value.trim().toLowerCase() }
  }
  return null
}

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase
      .from(TABLE)
      .select('id, term_norm, term_display, meaning, created_at, updated_at')
      .eq('account_id', accountId)
      .order('updated_at', { ascending: false })
    if (error) {
      if (missingTable(error)) return tableMissingResponse()
      console.error('[order-glossary GET] error:', error)
      return NextResponse.json({ error: 'Failed to load glossary' }, { status: 500 })
    }
    return NextResponse.json({ entries: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`order-glossary:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    const term = typeof body?.term === 'string' ? normalizeTerm(body.term) : ''
    if (!term) {
      return NextResponse.json({ error: 'Se requiere un término' }, { status: 400 })
    }
    const meaning = buildMeaning(body)
    if (!meaning) {
      return NextResponse.json(
        { error: 'Significado inválido (type: grosor|alias y su value)' },
        { status: 400 },
      )
    }

    const { data, error } = await supabase
      .from(TABLE)
      .upsert(
        {
          account_id: accountId,
          term_norm: term,
          term_display: typeof body?.term === 'string' && body.term.trim() ? body.term.trim() : term,
          meaning,
          created_by: userId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'account_id,term_norm' },
      )
      .select('id, term_norm, term_display, meaning, created_at, updated_at')
    if (error) {
      if (missingTable(error)) return tableMissingResponse()
      console.error('[order-glossary POST] error:', error)
      return NextResponse.json({ error: 'Failed to save term' }, { status: 500 })
    }
    return NextResponse.json({ entries: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`order-glossary:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const url = new URL(request.url)
    const id = url.searchParams.get('id')
    const term = normalizeTerm(url.searchParams.get('term') || '')
    if (!id && !term) {
      return NextResponse.json({ error: 'Falta id o term' }, { status: 400 })
    }

    let query = supabase.from(TABLE).delete().eq('account_id', accountId)
    query = id ? query.eq('id', id) : query.eq('term_norm', term)
    const { error } = await query
    if (error) {
      if (missingTable(error)) return tableMissingResponse()
      console.error('[order-glossary DELETE] error:', error)
      return NextResponse.json({ error: 'Failed to delete term' }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
