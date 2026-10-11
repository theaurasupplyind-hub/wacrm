import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

type Params = { params: Promise<{ id: string }> }

const TABLE = 'bot_allowed_numbers'

/**
 * PATCH  /api/bot/whitelist/[id] — edita label y/o active (admin+).
 * DELETE /api/bot/whitelist/[id] — elimina el número (admin+).
 */

function isNumericId(id: string): boolean {
  return /^\d+$/.test(id)
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await params
    if (!isNumericId(id)) {
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
    }

    const body = await request.json().catch(() => null)
    const update: Record<string, unknown> = {}
    if (typeof body?.label === 'string') update.label = body.label.trim() || null
    if (typeof body?.active === 'boolean') update.active = body.active
    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from(TABLE)
      .update(update)
      .eq('account_id', accountId)
      .eq('id', id)
      .select('id, phone, label, active, created_at')
      .maybeSingle()
    if (error) {
      console.error('[bot/whitelist PATCH] error:', error)
      return NextResponse.json({ error: 'Failed to update number' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ number: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await params
    if (!isNumericId(id)) {
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
    }

    const { error } = await supabase
      .from(TABLE)
      .delete()
      .eq('account_id', accountId)
      .eq('id', id)
    if (error) {
      console.error('[bot/whitelist DELETE] error:', error)
      return NextResponse.json({ error: 'Failed to delete number' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
