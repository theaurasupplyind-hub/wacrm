import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

type LogType = 'router' | 'expense' | 'attendance'

const TABLES: Record<LogType, string> = {
  router: 'router_logs',
  expense: 'expense_extractions',
  attendance: 'attendance_extractions',
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const rawType = searchParams.get('type') || 'router'
  const type: LogType =
    rawType === 'expense' || rawType === 'attendance' ? rawType : 'router'
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
    const table = TABLES[type]

    const { data, error } = await adminClient
      .from(table)
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) {
      if (error.message.includes('relation') && error.message.includes('does not exist')) {
        return NextResponse.json({
          error: `La tabla ${table} no existe. Ejecutá la migración 045_bot_debug_logs.sql en Supabase.`,
          hint: 'Copiá el SQL de supabase/migrations/045_bot_debug_logs.sql en el SQL Editor.',
        }, { status: 200 })
      }
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ total: data.length, records: data })
  } catch (err) {
    console.error(`[bot-logs/${type}] Error:`, err)
    return NextResponse.json(
      { error: 'Internal error' },
      { status: 500 },
    )
  }
}
