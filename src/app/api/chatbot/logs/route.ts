import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/ai/admin-client'

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const phone = searchParams.get('phone')
    const limit = parseInt(searchParams.get('limit') || '50', 10)
    const offset = parseInt(searchParams.get('offset') || '0', 10)

    let query = supabaseAdmin()
      .from('chatbot_logs')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .limit(Math.min(limit, 200))
      .range(offset, offset + limit - 1)

    if (phone) {
      query = query.ilike('phone', `%${phone.replace(/[^0-9]/g, '').slice(-6)}%`)
    }

    const { data, error, count } = await query

    if (error) {
      if (error.message.includes('relation') && error.message.includes('does not exist')) {
        return NextResponse.json({
          error: 'La tabla chatbot_logs no existe. Ejecutá la migración 032 en Supabase.',
          hint: 'Copiá el SQL de supabase/migrations/032_chatbot_logs.sql en el SQL Editor.',
        }, { status: 200 })
      }
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({
      total: count ?? 0,
      records: data ?? [],
    })
  } catch (err) {
    console.error('[chatbot/logs] Error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
