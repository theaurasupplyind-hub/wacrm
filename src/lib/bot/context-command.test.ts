import { describe, it, expect, vi } from 'vitest'

const cleared = vi.hoisted(() => ({
  voucher: vi.fn(async () => {}),
  expense: vi.fn(async () => {}),
  attendance: vi.fn(async () => {}),
  clarify: vi.fn(async () => {}),
  order: vi.fn(async () => {}),
}))

vi.mock('@/lib/ai/voucher-context', () => ({ clearVoucherContext: cleared.voucher }))
vi.mock('@/lib/expenses/context', () => ({ clearExpenseContext: cleared.expense }))
vi.mock('@/lib/attendance/context', () => ({ clearAttendanceContext: cleared.attendance }))
vi.mock('@/lib/bot-llm/clarify-context', () => ({ clearClarifyContext: cleared.clarify }))
vi.mock('@/lib/pedidos/context', () => ({ clearOrderContext: cleared.order }))

import { classifyContextCommand, handleContextCommand } from './context-command'

describe('classifyContextCommand', () => {
  it('detecta reset global', () => {
    expect(classifyContextCommand('reiniciar')).toBe('reset_all')
    expect(classifyContextCommand('empezar de nuevo')).toBe('reset_all')
    expect(classifyContextCommand('borrar todo')).toBe('reset_all')
    expect(classifyContextCommand('jesusdanielllavesecreta')).toBe('reset_all')
  })

  it('detecta cancelar del pendiente', () => {
    expect(classifyContextCommand('cancelar')).toBe('cancel_active')
    expect(classifyContextCommand('olvidalo')).toBe('cancel_active')
    expect(classifyContextCommand('mejor no')).toBe('cancel_active')
    expect(classifyContextCommand('después')).toBe('cancel_active')
    expect(classifyContextCommand('no lo creas, era una prueba')).toBe('cancel_active')
    expect(classifyContextCommand('no quiero un presupuesto')).toBe('cancel_active')
  })

  it('NO trata "no" ni textos normales como comando', () => {
    expect(classifyContextCommand('no')).toBeNull()
    expect(classifyContextCommand('no, era 5000')).toBeNull()
    expect(classifyContextCommand('cancela la factura de Juan')).toBeNull()
    expect(classifyContextCommand('hola')).toBeNull()
    expect(classifyContextCommand('')).toBeNull()
  })

  it('cancelar limpia también el presupuesto pendiente y lo explica', async () => {
    const db = {} as never
    const result = await handleContextCommand({
      db,
      conversationId: 'conv-1',
      command: 'cancel_active',
      active: { order: true },
    })

    expect(cleared.order).toHaveBeenCalledWith(db, 'conv-1')
    expect(result.reply).toContain('presupuesto pendiente')
  })
})
