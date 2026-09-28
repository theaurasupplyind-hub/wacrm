import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { rowToBotTrace } from '@/lib/bot-trace/schema'

const TABLE_HINT =
  'Copiá el SQL de supabase/migrations/048_bot_traces.sql en el SQL Editor de Supabase.'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const messageId = searchParams.get('messageId')
  const conversationId = searchParams.get('conversationId')
  const status = searchParams.get('status')
  const limit = Math.min(
    Math.max(parseInt(searchParams.get('limit') || '50', 10) || 50, 1),
    200,
  )

  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const adminClient = (await import('@/lib/ai/admin-client')).supabaseAdmin()

    let query = adminClient.from('bot_traces').select('*')
    if (messageId) query = query.eq('message_id', messageId)
    if (conversationId) query = query.eq('conversation_id', conversationId)
    if (status) query = query.eq('status', status)

    const { data, error } = await query
      .order('created_at', { ascending: false })
      .limit(messageId ? 1 : limit)

    if (error) {
      if (
        error.message.includes('relation') &&
        error.message.includes('does not exist')
      ) {
        return NextResponse.json(
          {
            error:
              'La tabla bot_traces no existe. Ejecutá la migración 048_bot_traces.sql en Supabase.',
            hint: TABLE_HINT,
            traces: [],
          },
          { status: 200 },
        )
      }
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const traces = (data ?? [])
      .map((row) => rowToBotTrace(row as Record<string, unknown>))
      .filter((t): t is NonNullable<typeof t> => t !== null)

    return NextResponse.json({ total: traces.length, traces })
  } catch (err) {
    console.error('[bot-traces] Error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
