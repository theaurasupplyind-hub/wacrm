import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { normalizeAllowedPhones } from '@/lib/bot/whitelist'

/**
 * GET  /api/bot/whitelist — lista los números autorizados del bot (cualquier miembro).
 * POST /api/bot/whitelist — agrega/activa uno o varios números (admin+).
 *
 * Solo los números de esta lista disparan el bot determinístico
 * (gastos/asistencia/voucher/asistente). Ver migración 050.
 */

const TABLE = 'bot_allowed_numbers'

function missingTable(error: { message?: string } | null): boolean {
  const msg = error?.message ?? ''
  return msg.includes('relation') && msg.includes('does not exist')
}

function tableMissingResponse() {
  return NextResponse.json(
    {
      error:
        'La tabla bot_allowed_numbers no existe. Ejecutá la migración 050_bot_allowed_numbers.sql en Supabase.',
    },
    { status: 503 },
  )
}

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase
      .from(TABLE)
      .select('id, phone, label, active, created_at')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
    if (error) {
      if (missingTable(error)) return tableMissingResponse()
      console.error('[bot/whitelist GET] error:', error)
      return NextResponse.json({ error: 'Failed to load whitelist' }, { status: 500 })
    }
    return NextResponse.json({ numbers: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`bot-whitelist:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)

    // Acepta un número ({ phone }) o varios ({ phones: [...] }).
    const rawPhones: unknown[] = Array.isArray(body?.phones)
      ? body.phones
      : typeof body?.phone === 'string'
        ? [body.phone]
        : []
    const label =
      typeof body?.label === 'string' && body.label.trim() ? body.label.trim() : null

    const phones = normalizeAllowedPhones(rawPhones)
    if (phones.length === 0) {
      return NextResponse.json(
        { error: 'Se requiere al menos un teléfono válido' },
        { status: 400 },
      )
    }

    // `label` solo se incluye si viene: así el upsert de un alta rápida (sin
    // etiqueta) no pisa la etiqueta de una fila existente.
    const rows = phones.map((phone) => {
      const row: Record<string, unknown> = { account_id: accountId, phone, active: true }
      if (label) row.label = label
      return row
    })

    const { data, error } = await supabase
      .from(TABLE)
      .upsert(rows, { onConflict: 'account_id,phone' })
      .select('id, phone, label, active, created_at')
    if (error) {
      if (missingTable(error)) return tableMissingResponse()
      console.error('[bot/whitelist POST] error:', error)
      return NextResponse.json({ error: 'Failed to save numbers' }, { status: 500 })
    }
    return NextResponse.json({ numbers: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}
