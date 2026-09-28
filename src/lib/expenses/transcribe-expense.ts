import { transcribeAudio } from '@/lib/audio/transcribe'
import type { TranscribeLog } from '@/lib/audio/transcribe'

export async function transcribeExpense(
  buffer: Buffer,
  mimeType: string,
): Promise<string> {
  const logs: TranscribeLog[] = []
  return transcribeAudio(buffer, mimeType, logs)
}
