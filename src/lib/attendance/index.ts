import { searchEmployees, getEmployee, createAttendance, type AttendanceRecord } from '@/lib/facbal/client'
import { engineSendText } from '@/lib/flows/meta-send'
import { parseAttendance, looksLikeAttendance, type AttendanceStatusType } from './parse-attendance'

export interface ProcessAttendanceArgs {
  text: string
  accountId: string
  userId: string
  conversationId: string
  contactId: string
}

export interface ProcessAttendanceResult {
  handled: boolean
  employeeName?: string
  time?: string
  date?: string
  error?: string
}

const STATUS_TO_LABEL: Record<AttendanceStatusType, { status: string; icon: string }> = {
  arrival: { status: '', icon: '' },
  vacaciones: { status: 'VACACIONES', icon: '🏖' },
  licencia: { status: 'LICENCIA', icon: '🏥' },
  ausente: { status: 'AUS', icon: '❌' },
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${d}/${m}/${y}`
}

async function sendTextResponse(ctx: {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
}, text: string) {
  try {
    await engineSendText({ ...ctx, text })
  } catch (err) {
    console.error('[attendance] send error:', err)
  }
}

function tokenScore(a: string, b: string): number {
  const na = a.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  const nb = b.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  if (!na || !nb) return 0
  if (na === nb) return 1
  if (na.startsWith(nb) || nb.startsWith(na)) return 0.95
  if (na.includes(nb) || nb.includes(na)) return 0.85
  const tokensA = na.split(' ')
  const tokensB = nb.split(' ')
  const common = tokensA.filter(t => tokensB.some(bt => t === bt || t.includes(bt) || bt.includes(t)))
  return common.length / Math.max(tokensA.length, tokensB.length)
}

function buildStatus(parsed: { statusType: AttendanceStatusType; time: string | null }, emp: { entry_time?: string | null; late_threshold?: number } | null): { status: string; label: string } {
  if (parsed.statusType === 'arrival') {
    const rawTime = parsed.time || '00:00'
    let status = rawTime
    let label = rawTime

    if (emp?.entry_time && rawTime !== '00:00') {
      const [eh, em] = emp.entry_time.split(':').map(Number)
      const [th, tm] = rawTime.split(':').map(Number)
      const diff = (th * 60 + tm) - (eh * 60 + em)
      const threshold = emp.late_threshold ?? 5
      if (diff > threshold) {
        status = `TARDE-${rawTime}`
        label = `⏰ ${rawTime} (tarde)`
      }
    }
    return { status, label }
  }

  const entry = STATUS_TO_LABEL[parsed.statusType]
  return { status: entry.status, label: `${entry.icon} ${entry.status.toLowerCase()}` }
}

export async function processAttendanceMessage(
  args: ProcessAttendanceArgs,
): Promise<ProcessAttendanceResult> {
  const parsed = parseAttendance(args.text)

  if (!parsed.isAttendanceIntent || !parsed.employeeName) {
    return { handled: false }
  }

  try {
    const employees = await searchEmployees(parsed.employeeName)

    if (!employees || employees.length === 0) {
      const msg = `No encontré ningún empleado con el nombre "${parsed.employeeName}".`
      await sendTextResponse(args, msg)
      return { handled: true, error: msg }
    }

    let bestMatch = employees[0]
    let bestScore = tokenScore(bestMatch.name, parsed.employeeName)

    for (let i = 1; i < employees.length; i++) {
      const score = tokenScore(employees[i].name, parsed.employeeName)
      if (score > bestScore) {
        bestScore = score
        bestMatch = employees[i]
      }
    }

    if (bestScore < 0.4) {
      const msg = `No encontré ningún empleado con el nombre "${parsed.employeeName}".`
      await sendTextResponse(args, msg)
      return { handled: true, error: msg }
    }

    const emp = parsed.statusType === 'arrival' ? await getEmployee(bestMatch.id) : null
    const { status: finalStatus, label } = buildStatus(parsed, emp)

    const record: AttendanceRecord = {
      employee_id: bestMatch.id,
      date: parsed.date,
      status: finalStatus,
    }
    await createAttendance(record)

    const dateFormatted = formatDate(parsed.date)
    const msg = `✅ Asistencia registrada:\n👤 ${bestMatch.name}\n${label}\n📅 ${dateFormatted}`
    await sendTextResponse(args, msg)

    return { handled: true, employeeName: bestMatch.name, time: label, date: parsed.date }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[attendance] process error:', msg)
    const errorResp = '❌ No pude registrar la asistencia. Intentá de nuevo o contactá al administrador.'
    await sendTextResponse(args, errorResp)
    return { handled: true, error: msg }
  }
}

export { looksLikeAttendance }
