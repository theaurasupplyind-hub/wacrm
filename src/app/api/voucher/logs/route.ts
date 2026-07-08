import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET() {
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

    const { data, error } = await adminClient
      .from('voucher_extractions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20)

    if (error) {
      if (error.message.includes('relation') && error.message.includes('does not exist')) {
        return NextResponse.json({
          error: 'La tabla voucher_extractions no existe. Ejecutá la migración 031 en Supabase.',
          hint: 'Copiá el SQL de supabase/migrations/031_voucher_extractions.sql en el SQL Editor.',
        }, { status: 200 })
      }
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Check environment
    const envStatus = {
      VOUCHER_AI_MODEL: process.env.VOUCHER_AI_MODEL || 'google/gemini-2.5-flash (default)',
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ? 'configurada' : 'NO CONFIGURADA',
      FACBAL_API_URL: process.env.FACBAL_API_URL || 'NO CONFIGURADA',
      FACBAL_API_KEY: process.env.FACBAL_API_KEY ? 'configurada' : 'NO CONFIGURADA',
    }

    return NextResponse.json({
      total: data.length,
      envStatus,
      records: data,
    })
  } catch (err) {
    console.error('[voucher/logs] Error:', err)
    return NextResponse.json(
      { error: 'Internal error' },
      { status: 500 },
    )
  }
}
