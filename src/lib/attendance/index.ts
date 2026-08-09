import {
  searchEmployees,
  getEmployee,
  createAttendance,
  getAttendance,
  type AttendanceRecord,
  type Employee,
  type AttendanceRow,
} from '@/lib/facbal/client'
import { engineSendText, engineSendInteractiveButtons } from '@/lib/flows/meta-send'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  loadAttendanceContext,
  saveAttendanceContext,
  clearAttendanceContext,
  type AttendanceContextState,
} from './context'
import {
  parseAttendance,
  looksLikeAttendance,
  extractAttendanceDate,
  type AttendanceStatusType,
  type ParsedAttendance,
} from './parse-attendance'
import { normalizeTime } from '@/lib/bot-llm/sanitize'
import type { UnifiedExtraction } from '@/lib/bot-llm/types'

export const ATT_CORRECT_ID = 'att_correct_time'
export const ATT_LEAVE_ID = 'att_leave_time'

export interface ProcessAttendanceArgs {
  db: SupabaseClient
  text: string
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  /** WhatsApp message ID (Meta), para correlacionar con la tabla messages. */
  messageId?: string | null
}

export interface ProcessAttendanceResult {
  handled: boolean
  employeeName?: string
  time?: string
  date?: string
  error?: string
  awaitingCorrection?: boolean
}

const STATUS_TO_LABEL: Record<AttendanceStatusType, { status: string; icon: string }> = {
  arrival: { status: '', icon: '' },
  departure: { status: '', icon: '' },
  vacaciones: { status: 'VACACIONES', icon: '🏖' },
  licencia: { status: 'LICENCIA', icon: '🏥' },
  ausente: { status: 'AUS', icon: '❌' },
}

function todayString(): string {
  return new Date().toISOString().slice(0, 10)
}

function intentFromStatus(statusType: AttendanceStatusType): string {
  if (statusType === 'arrival') return 'asistencia_llegada'
  if (statusType === 'departure') return 'asistencia_salida'
  return 'asistencia_estado'
}

interface AttendanceLogEntry {
  outcome: string
  intent?: string | null
  extractorSource?: string | null
  employeeName?: string | null
  time?: string | null
  date?: string | null
  statusType?: string | null
  faltanCampos?: string[] | null
  matchedEmployeeId?: number | null
  matchedEmployeeName?: string | null
  errorMessage?: string | null
  debug?: Record<string, unknown>
}

/**
 * Auditoría de cada evento del flujo de asistencia en `attendance_extractions`
 * (migración 045). Fire-and-forget: nunca debe romper el procesamiento.
 */
async function logAttendanceExtraction(args: ProcessAttendanceArgs, entry: AttendanceLogEntry) {
  try {
    await args.db.from('attendance_extractions').insert({
      message_id: args.messageId || null,
      contact_id: args.contactId,
      conversation_id: args.conversationId,
      raw_text: args.text || null,
      intent: entry.intent ?? null,
      extractor_source: entry.extractorSource ?? null,
      employee_name: entry.employeeName ?? null,
      time: entry.time ?? null,
      date: entry.date ?? null,
      status_type: entry.statusType ?? null,
      faltan_campos: entry.faltanCampos ?? null,
      outcome: entry.outcome,
      matched_employee_id: entry.matchedEmployeeId ?? null,
      matched_employee_name: entry.matchedEmployeeName ?? null,
      error_message: entry.errorMessage ?? null,
      debug_info: entry.debug ?? null,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('relation') && msg.includes('does not exist')) {
      console.error('[attendance-log] TABLE MISSING — run migration 045_bot_debug_logs.sql in Supabase')
    } else {
      console.error('[attendance-log] Failed to save attendance extraction:', msg)
    }
  }
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

async function sendAttendanceButtons(ctx: {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
}, text: string, buttons: { id: string; title: string }[]) {
  try {
    await engineSendInteractiveButtons({
      accountId: ctx.accountId,
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      contactId: ctx.contactId,
      bodyText: text,
      buttons,
    })
  } catch (err) {
    console.error('[attendance] send buttons error:', err)
    await sendTextResponse(ctx, text)
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

function isTimeLike(status: string | null | undefined): boolean {
  return !!status && /^\d{2}:\d{2}$/.test(status)
}

function isArrivalStatus(status: string | null | undefined): boolean {
  return isTimeLike(status) || (!!status && status.startsWith('TARDE-'))
}

function findArrival(rows: AttendanceRow[] | null | undefined): AttendanceRow | null {
  if (!rows) return null
  return rows.find(r => isArrivalStatus(r.status)) || null
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
        label = `⏰ ${rawTime} · llegó ${diff} min tarde (entrada ${emp.entry_time}, tolerancia ${threshold} min)`
      }
    }
    return { status, label }
  }

  const entry = STATUS_TO_LABEL[parsed.statusType]
  return { status: entry.status, label: `${entry.icon} ${entry.status.toLowerCase()}` }
}

async function recordArrival(
  args: ProcessAttendanceArgs,
  emp: Employee,
  time: string,
  date: string,
): Promise<ProcessAttendanceResult> {
  const fullEmp = await getEmployee(emp.id)
  const { status: finalStatus, label } = buildStatus({ statusType: 'arrival', time }, fullEmp)
  const record: AttendanceRecord = { employee_id: emp.id, date, status: finalStatus }
  await createAttendance(record)

  const dateFormatted = formatDate(date)
  const msg = `✅ Asistencia registrada:\n👤 ${emp.name}\n${label}\n📅 ${dateFormatted}`
  await sendTextResponse(args, msg)

  await logAttendanceExtraction(args, {
    outcome: 'recorded',
    intent: 'asistencia_llegada',
    employeeName: emp.name,
    time: finalStatus,
    date,
    statusType: 'arrival',
    matchedEmployeeId: emp.id,
    matchedEmployeeName: emp.name,
    debug: { recorded: { time, label, status: finalStatus } },
  })

  return { handled: true, employeeName: emp.name, time: label, date }
}

async function handleArrival(
  args: ProcessAttendanceArgs,
  emp: Employee,
  parsedTime: string,
  date: string,
): Promise<ProcessAttendanceResult> {
  // Dedupe: segunda llegada el mismo día → preguntar antes de sobrescribir
  let existing: AttendanceRow[] = []
  try {
    existing = await getAttendance(emp.id, date)
  } catch (err) {
    console.error('[attendance] getAttendance error:', err)
  }

  const existingArrival = findArrival(existing)
  if (existingArrival) {
    await saveAttendanceContext(args.db, args.conversationId, {
      pendingType: 'arrival',
      pendingDate: date,
      pendingTime: parsedTime,
      awaitingCorrection: true,
      existingEmployeeId: emp.id,
      existingStatus: existingArrival.status,
    })

    const previous = (existingArrival.status || '').replace('TARDE-', '')
    const msg =
      `⚠️ ${emp.name} ya tiene una llegada registrada a las ${previous} hoy.\n` +
      `¿Querés corregir la hora a ${parsedTime}?`
    await sendAttendanceButtons(args, msg, [
      { id: ATT_CORRECT_ID, title: '✅ Corregir hora' },
      { id: ATT_LEAVE_ID, title: '❌ No tocar' },
    ])

    await logAttendanceExtraction(args, {
      outcome: 'awaiting_correction',
      intent: 'asistencia_llegada',
      employeeName: emp.name,
      time: parsedTime,
      date,
      statusType: 'arrival',
      matchedEmployeeId: emp.id,
      matchedEmployeeName: emp.name,
      debug: { existingStatus: existingArrival.status, previous },
    })

    return { handled: true, awaitingCorrection: true }
  }

  return recordArrival(args, emp, parsedTime, date)
}

async function handleDeparture(
  args: ProcessAttendanceArgs,
  emp: Employee,
  parsedTime: string,
  date: string,
): Promise<ProcessAttendanceResult> {
  // Secuencia: salida sin llegada previa → rechazar
  let existing: AttendanceRow[] = []
  try {
    existing = await getAttendance(emp.id, date)
  } catch (err) {
    console.error('[attendance] getAttendance error:', err)
  }

  const existingArrival = findArrival(existing)
  if (!existingArrival) {
    const msg = `❌ ${emp.name} no tiene una llegada registrada hoy. Primero registrá su llegada.`
    await sendTextResponse(args, msg)

    await logAttendanceExtraction(args, {
      outcome: 'rejected_no_arrival',
      intent: 'asistencia_salida',
      employeeName: emp.name,
      time: parsedTime,
      date,
      statusType: 'departure',
      matchedEmployeeId: emp.id,
      matchedEmployeeName: emp.name,
      errorMessage: msg,
    })

    return { handled: true, error: msg }
  }

  const record: AttendanceRecord = {
    employee_id: emp.id,
    date,
    status: existingArrival.status || undefined,
    exit_time: parsedTime,
  }
  await createAttendance(record)

  const fullEmp = await getEmployee(emp.id)
  let extra = ''
  if (fullEmp?.exit_time && fullEmp.exit_time !== parsedTime) {
    extra = `\nℹ️ Su horario de salida esperado es ${fullEmp.exit_time}.`
  }

  const dateFormatted = formatDate(date)
  const msg = `🚪 Salida registrada:\n👤 ${emp.name}\n🕔 ${parsedTime}\n📅 ${dateFormatted}${extra}`
  await sendTextResponse(args, msg)

  await logAttendanceExtraction(args, {
    outcome: 'recorded',
    intent: 'asistencia_salida',
    employeeName: emp.name,
    time: parsedTime,
    date,
    statusType: 'departure',
    matchedEmployeeId: emp.id,
    matchedEmployeeName: emp.name,
    debug: { expectedExitTime: fullEmp?.exit_time ?? null },
  })

  return { handled: true, employeeName: emp.name, time: parsedTime, date }
}

async function handleStatus(
  args: ProcessAttendanceArgs,
  emp: Employee,
  statusType: AttendanceStatusType,
  date: string,
): Promise<ProcessAttendanceResult> {
  const { status, label } = buildStatus({ statusType, time: null }, null)
  const record: AttendanceRecord = { employee_id: emp.id, date, status }
  await createAttendance(record)

  const dateFormatted = formatDate(date)
  const msg = `✅ Asistencia registrada:\n👤 ${emp.name}\n${label}\n📅 ${dateFormatted}`
  await sendTextResponse(args, msg)

  await logAttendanceExtraction(args, {
    outcome: 'recorded',
    intent: intentFromStatus(statusType),
    employeeName: emp.name,
    date,
    statusType,
    matchedEmployeeId: emp.id,
    matchedEmployeeName: emp.name,
    debug: { label, status },
  })

  return { handled: true, employeeName: emp.name, time: label, date }
}

interface ResolveArgs extends ProcessAttendanceArgs {
  employeeName: string
  statusType: AttendanceStatusType
  date: string
  time: string | null
}

async function resolveEmployeeAndRecord(args: ResolveArgs): Promise<ProcessAttendanceResult> {
  const name = (args.employeeName || '').trim()
  if (!name) {
    await saveAttendanceContext(args.db, args.conversationId, {
      pendingType: args.statusType,
      pendingDate: args.date,
      pendingTime: args.time,
    })
    const msg = '¿De quién es? Decime el nombre del empleado.'
    await sendTextResponse(args, msg)
    return { handled: true }
  }

  try {
    const employees = await searchEmployees(name)

    let bestMatch: Employee | null = null
    let bestScore = 0
    if (employees && employees.length > 0) {
      bestMatch = employees[0]
      bestScore = tokenScore(bestMatch.name, name)
      for (let i = 1; i < employees.length; i++) {
        const score = tokenScore(employees[i].name, name)
        if (score > bestScore) {
          bestScore = score
          bestMatch = employees[i]
        }
      }
    }

    if (!bestMatch || bestScore < 0.4) {
      await saveAttendanceContext(args.db, args.conversationId, {
        pendingType: args.statusType,
        pendingDate: args.date,
        pendingTime: args.time,
        pendingEmployee: name,
      })
      const msg = `No encontré ningún empleado con el nombre "${name}". ¿De quién es?`
      await sendTextResponse(args, msg)

      await logAttendanceExtraction(args, {
        outcome: 'employee_not_found',
        intent: intentFromStatus(args.statusType),
        employeeName: name,
        time: args.time,
        date: args.date,
        statusType: args.statusType,
        errorMessage: msg,
        debug: { bestScore: bestScore ?? null },
      })

      return { handled: true, error: msg }
    }

    await clearAttendanceContext(args.db, args.conversationId)

    switch (args.statusType) {
      case 'arrival':
        return handleArrival(args, bestMatch, args.time || '00:00', args.date)
      case 'departure':
        return handleDeparture(args, bestMatch, args.time || '00:00', args.date)
      default:
        return handleStatus(args, bestMatch, args.statusType, args.date)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[attendance] process error:', msg)
    const errorResp = '❌ No pude registrar la asistencia. Intentá de nuevo o contactá al administrador.'
    await sendTextResponse(args, errorResp)

    await logAttendanceExtraction(args, {
      outcome: 'error',
      intent: intentFromStatus(args.statusType),
      employeeName: args.employeeName,
      time: args.time,
      date: args.date,
      statusType: args.statusType,
      errorMessage: msg,
    })

    return { handled: true, error: msg }
  }
}

function extractionToParsedAttendance(extraction: UnifiedExtraction, raw: string): ParsedAttendance {
  let statusType: AttendanceStatusType = 'arrival'
  if (extraction.intent === 'asistencia_salida') {
    statusType = 'departure'
  } else if (extraction.intent === 'asistencia_estado') {
    statusType = extraction.estado || 'ausente'
  }

  return {
    employeeName: extraction.empleado,
    time: extraction.hora,
    date: extractAttendanceDate(raw) || extraction.fecha || todayString(),
    raw,
    isAttendanceIntent: true,
    statusType,
  }
}

export async function processAttendanceMessage(
  args: ProcessAttendanceArgs,
  extraction?: UnifiedExtraction,
): Promise<ProcessAttendanceResult> {
  const ctx = await loadAttendanceContext(args.db, args.conversationId)
  let parsed =
    extraction && extraction.intent.startsWith('asistencia')
      ? extractionToParsedAttendance(extraction, args.text)
      : parseAttendance(args.text)

  // Las respuestas a los botones de corrección se manejan aparte
  // (processAttendanceConfirmReply). Si mientras tanto llega un mensaje de
  // asistencia completo nuevo, se resetea el contexto y se procesa en fresco.
  if (ctx.awaitingCorrection) {
    const isFreshIntent = parsed.isAttendanceIntent && !!parsed.employeeName
    if (!isFreshIntent) {
      await logAttendanceExtraction(args, {
        outcome: 'not_handled',
        extractorSource: extraction?.extractor_source ?? null,
        debug: { reason: 'awaiting_correction_no_fresh_intent', ctx },
      })
      return { handled: false }
    }
    await clearAttendanceContext(args.db, args.conversationId)
  }

  // Multi-turno: esperando la HORA (el empleado ya se resolvió y no hay hora).
  if (ctx.pendingType && ctx.pendingEmployee && ctx.awaitingTime) {
    const time = parsed.time || normalizeTime(args.text)
    if (!time) {
      await saveAttendanceContext(args.db, args.conversationId, { ...ctx })
      const tipo = ctx.pendingType === 'arrival' ? 'llegó' : 'salió'
      const msg = `No entendí la hora. ¿A qué hora ${tipo} ${ctx.pendingEmployee}? (ej: 9:30)`
      await sendTextResponse(args, msg)

      await logAttendanceExtraction(args, {
        outcome: 'ask_time',
        intent: intentFromStatus(ctx.pendingType),
        extractorSource: extraction?.extractor_source ?? null,
        employeeName: ctx.pendingEmployee,
        time: null,
        date: ctx.pendingDate || todayString(),
        statusType: ctx.pendingType,
        faltanCampos: ['hora'],
        debug: { reask: true, ctx },
      })

      return { handled: true }
    }
    await clearAttendanceContext(args.db, args.conversationId)
    return resolveEmployeeAndRecord({
      ...args,
      employeeName: ctx.pendingEmployee,
      statusType: ctx.pendingType,
      date: ctx.pendingDate || parsed.date || todayString(),
      time,
    })
  }

  // Multi-turno: hay un empleado pendiente de resolver → el texto actual es el nombre.
  if (ctx.pendingType && !ctx.awaitingTime) {
    const isFreshIntent = parsed.isAttendanceIntent && !!parsed.employeeName
    if (!isFreshIntent) {
      return resolveEmployeeAndRecord({
        ...args,
        employeeName: (args.text || '').trim(),
        statusType: ctx.pendingType,
        date: ctx.pendingDate || parsed.date,
        time: ctx.pendingTime || parsed.time,
      })
    }
    // El LLM resolvió el nombre como intent fresco, pero si la hora ya se había
    // dado antes ("llegó a las 8:30" → "juan"), conservarla en vez de pedirla de nuevo.
    if (ctx.pendingTime && !parsed.time) {
      parsed = { ...parsed, time: ctx.pendingTime }
    }
    await clearAttendanceContext(args.db, args.conversationId)
  }

  if (!parsed.isAttendanceIntent) {
    await logAttendanceExtraction(args, {
      outcome: 'not_handled',
      intent: extraction?.intent ?? null,
      extractorSource: extraction?.extractor_source ?? null,
      employeeName: extraction?.empleado ?? null,
      faltanCampos: extraction?.faltan_campos ?? null,
      debug: { reason: 'not_an_attendance_intent', ctx },
    })
    return { handled: false }
  }

  // Sin nombre → preguntar de quién es (multi-turno)
  if (!parsed.employeeName) {
    await saveAttendanceContext(args.db, args.conversationId, {
      pendingType: parsed.statusType,
      pendingDate: parsed.date,
      pendingTime: parsed.time || null,
    })
    const msg = '¿De quién es? Decime el nombre del empleado.'
    await sendTextResponse(args, msg)

    await logAttendanceExtraction(args, {
      outcome: 'ask_employee',
      intent: intentFromStatus(parsed.statusType),
      extractorSource: extraction?.extractor_source ?? null,
      employeeName: null,
      time: parsed.time,
      date: parsed.date,
      statusType: parsed.statusType,
      faltanCampos: ['empleado'],
      debug: { ctx },
    })

    return { handled: true }
  }

  // Sin hora en llegada/salida → preguntar la hora (en vez de asumir 00:00)
  if (
    (parsed.statusType === 'arrival' || parsed.statusType === 'departure') &&
    !parsed.time
  ) {
    await saveAttendanceContext(args.db, args.conversationId, {
      pendingType: parsed.statusType,
      pendingDate: parsed.date,
      pendingEmployee: parsed.employeeName,
      pendingTime: null,
      awaitingTime: true,
    })
    const tipo = parsed.statusType === 'arrival' ? 'llegó' : 'salió'
    const msg = `¿A qué hora ${tipo} ${parsed.employeeName}?`
    await sendTextResponse(args, msg)

    await logAttendanceExtraction(args, {
      outcome: 'ask_time',
      intent: intentFromStatus(parsed.statusType),
      extractorSource: extraction?.extractor_source ?? null,
      employeeName: parsed.employeeName,
      time: null,
      date: parsed.date,
      statusType: parsed.statusType,
      faltanCampos: ['hora'],
      debug: { ctx },
    })

    return { handled: true }
  }

  return resolveEmployeeAndRecord({
    ...args,
    employeeName: parsed.employeeName,
    statusType: parsed.statusType,
    date: parsed.date,
    time: parsed.time,
  })
}

export async function processAttendanceConfirmReply(
  args: ProcessAttendanceArgs,
  replyId: string,
): Promise<ProcessAttendanceResult> {
  const ctx = await loadAttendanceContext(args.db, args.conversationId)
  if (!ctx.awaitingCorrection) {
    return { handled: false }
  }

  if (replyId === ATT_CORRECT_ID && ctx.existingEmployeeId && ctx.pendingTime) {
    const date = ctx.pendingDate || todayString()
    try {
      const fullEmp = await getEmployee(ctx.existingEmployeeId)
      const { status: finalStatus } = buildStatus({ statusType: 'arrival', time: ctx.pendingTime }, fullEmp)
      const record: AttendanceRecord = {
        employee_id: ctx.existingEmployeeId,
        date,
        status: finalStatus,
      }
      await createAttendance(record)

      await clearAttendanceContext(args.db, args.conversationId)
      const dateFormatted = formatDate(date)
      const msg = `✅ Hora corregida:\n👤 ${fullEmp?.name || ''}\n🕔 ${ctx.pendingTime}\n📅 ${dateFormatted}`
      await sendTextResponse(args, msg)

      await logAttendanceExtraction(args, {
        outcome: 'correction_recorded',
        intent: 'asistencia_llegada',
        employeeName: fullEmp?.name ?? null,
        time: ctx.pendingTime,
        date,
        statusType: 'arrival',
        matchedEmployeeId: ctx.existingEmployeeId,
        matchedEmployeeName: fullEmp?.name ?? null,
        debug: { replyId, finalStatus, ctx },
      })

      return { handled: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[attendance] correction error:', msg)
      await clearAttendanceContext(args.db, args.conversationId)
      const errorResp = '❌ No pude corregir la hora. Intentá de nuevo.'
      await sendTextResponse(args, errorResp)

      await logAttendanceExtraction(args, {
        outcome: 'error',
        intent: 'asistencia_llegada',
        employeeName: ctx.pendingEmployee ?? null,
        time: ctx.pendingTime,
        date,
        statusType: 'arrival',
        matchedEmployeeId: ctx.existingEmployeeId,
        errorMessage: msg,
        debug: { replyId, flow: 'correction' },
      })

      return { handled: true, error: msg }
    }
  }

  // ❌ No tocar
  await clearAttendanceContext(args.db, args.conversationId)
  const msg = 'Listo, no toqué la hora registrada. 👍'
  await sendTextResponse(args, msg)

  await logAttendanceExtraction(args, {
    outcome: 'correction_ignored',
    intent: 'asistencia_llegada',
    employeeName: ctx.pendingEmployee ?? null,
    time: ctx.pendingTime,
    date: ctx.pendingDate || todayString(),
    statusType: 'arrival',
    matchedEmployeeId: ctx.existingEmployeeId,
    debug: { replyId, ctx },
  })

  return { handled: true }
}

export {
  loadAttendanceContext,
  saveAttendanceContext,
  clearAttendanceContext,
}
export { looksLikeAttendance }
export type { AttendanceContextState }
