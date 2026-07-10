import { supabaseAdmin } from './admin-client'

interface LogRow {
  phone: string
  message_text: string | null
  step: string
  data: Record<string, unknown> | null
  duration_ms: number | null
  account_id: string
  created_at: string
}

export async function getRecentLogs(args: {
  phone?: string
  accountId?: string
  minutes?: number
}): Promise<LogRow[]> {
  const { phone, accountId, minutes = 30 } = args
  const since = new Date(Date.now() - minutes * 60 * 1000).toISOString()
  const admin = supabaseAdmin()

  let query = admin
    .from('chatbot_logs')
    .select('*')
    .gte('created_at', since)
    .order('created_at', { ascending: true })

  if (phone) query = query.eq('phone', phone)
  if (accountId) query = query.eq('account_id', accountId)

  const { data, error } = await query
  if (error) throw error
  return (data as LogRow[]) || []
}

export function formatLogs(logs: LogRow[]): string {
  const lines: string[] = []
  for (const l of logs) {
    const ts = new Date(l.created_at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
    const msg = l.message_text ? ` "${l.message_text.slice(0, 50)}"` : ''
    const dataStr = l.data
      ? Object.entries(l.data)
          .filter(([k]) => !['raw_text', 'conversation_id', 'response_preview', 'context_preview'].includes(k))
          .map(([k, v]) => {
            if (typeof v === 'object') {
              if (v && typeof v === 'object' && 'length' in v && 'total' in v) {
                return `cart=${(v as { length: number }).length}items`
              }
              return ''
            }
            return `${k}=${v}`
          })
          .filter(Boolean)
          .join(' ')
      : ''
    lines.push(`[${ts}] ${l.step}${msg} | ${dataStr}`)
  }
  return lines.join('\n')
}
