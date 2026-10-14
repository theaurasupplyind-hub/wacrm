import { describe, it, expect } from 'vitest'
import {
  UNDO_WINDOW_HOURS,
  resolveUndoAction,
  attendanceKey,
  parseAttendanceKey,
  type WriteLogRow,
} from './undo-log'

function row(over: Partial<WriteLogRow> = {}): WriteLogRow {
  return {
    id: 1,
    entity: 'gasto',
    entity_id: 42,
    entity_key: null,
    summary: 'gasto',
    undone_at: null,
    created_at: new Date().toISOString(),
    ...over,
  }
}

describe('undo log (Fase 2)', () => {
  it('ventana de undo de 24h (acordada)', () => {
    expect(UNDO_WINDOW_HOURS).toBe(24)
  })

  it('resuelve gasto/factura/pago por id', () => {
    expect(resolveUndoAction(row({ entity: 'gasto', entity_id: 7 }))?.entity_id).toBe(7)
    expect(resolveUndoAction(row({ entity: 'factura', entity_id: 9 }))?.entity).toBe('factura')
    expect(resolveUndoAction(row({ entity: 'pago', entity_id: 3 }))?.entity).toBe('pago')
  })

  it('gasto sin id no se puede deshacer', () => {
    expect(resolveUndoAction(row({ entity: 'gasto', entity_id: null }))).toBeNull()
  })

  it('asistencia se resuelve por clave nombre+fecha', () => {
    const key = attendanceKey('Juan', '2026-10-14')
    const action = resolveUndoAction(row({ entity: 'asistencia', entity_id: null, entity_key: key }))
    expect(action?.entity).toBe('asistencia')
    expect(parseAttendanceKey(action!.entity_key!)).toEqual({ empleado: 'Juan', fecha: '2026-10-14' })
  })

  it('entidad desconocida no se puede deshacer', () => {
    expect(resolveUndoAction(row({ entity: 'nave_espacial' }))).toBeNull()
  })

  it('parseAttendanceKey tolera basura', () => {
    expect(parseAttendanceKey('no-json')).toBeNull()
    expect(parseAttendanceKey(JSON.stringify({ empleado: 'x' }))).toBeNull()
  })
})
