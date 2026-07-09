import { supabaseAdmin } from './admin-client'

interface LogEntry {
  phone: string
  message_text?: string
  step: string
  data?: Record<string, unknown>
  duration_ms?: number
  account_id: string
}

export async function logChatbotStep(entry: LogEntry): Promise<void> {
  try {
    const admin = supabaseAdmin()
    await admin.from('chatbot_logs').insert({
      phone: entry.phone,
      message_text: entry.message_text?.slice(0, 200) ?? null,
      step: entry.step,
      data: entry.data ?? null,
      duration_ms: entry.duration_ms ?? null,
      account_id: entry.account_id,
    })
  } catch (err) {
    console.error('[chatbot-logger] Failed to insert log:', err)
  }
}
