import { transcribeAudio } from '@/lib/voice-orders/transcribe'
import type { VoiceOrderLog } from '@/lib/voice-orders/types'

export async function transcribeExpense(
  buffer: Buffer,
  mimeType: string,
): Promise<string> {
  const logs: VoiceOrderLog[] = []
  return transcribeAudio(buffer, mimeType, logs)
}
