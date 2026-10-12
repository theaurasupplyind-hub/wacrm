import { describe, it, expect, afterEach } from 'vitest'
import { applyPolicy, isWriteAction, writeKey, getPlannerDomains, plannerWritesEnabled } from './policy'
import type { TurnAction } from './actions'

const expense = (text: string): TurnAction => ({ kind: 'run_expense', text, extraction: null })
const attendance = (text: string): TurnAction => ({ kind: 'run_attendance', text, extraction: null })
const read: TurnAction = { kind: 'run_assistant', text: 'hola', extraction: null }

afterEach(() => {
  delete process.env.ASSISTANT_PLANNER_DOMAINS
  delete process.env.ASSISTANT_PLANNER_WRITES
})

describe('applyPolicy (Fase 5)', () => {
  it('maxWritesPerTurn=1: descarta la segunda escritura', () => {
    const out = applyPolicy([expense('a'), attendance('b')], { maxWritesPerTurn: 1 })
    expect(out).toHaveLength(1)
    expect(isWriteAction(out[0])).toBe(true)
  })

  it('no cuenta lecturas como escrituras', () => {
    const out = applyPolicy([read, expense('a')], { maxWritesPerTurn: 1 })
    expect(out).toHaveLength(2)
  })

  it('el texto de la escritura se reemplaza por el original del usuario', () => {
    const out = applyPolicy([expense('gasté 999999 inventado')], {
      maxWritesPerTurn: 1,
      originalText: 'pagué 5000 de luz',
    })
    expect(out[0]).toMatchObject({ kind: 'run_expense', text: 'pagué 5000 de luz' })
  })

  it('no toca escrituras sin texto (voucher por texto)', () => {
    const voucher: TurnAction = {
      kind: 'run_voucher_text', clientName: 'Marlon', destName: null,
      metodoPago: 'Efectivo', monto: 65000, fecha: null,
    }
    const out = applyPolicy([voucher], { maxWritesPerTurn: 1, originalText: 'otra cosa' })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'run_voucher_text', clientName: 'Marlon' })
  })

  it('dedupe por seenWriteKeys: una misma escritura no se emite dos veces', () => {
    const seen = new Set<string>()
    const out = applyPolicy([expense('mismo'), expense('mismo')], { maxWritesPerTurn: 5, seenWriteKeys: seen })
    expect(out).toHaveLength(1)
  })

  it('writeKey es estable', () => {
    expect(writeKey(expense('x'))).toBe('run_expense:x')
  })
})

describe('plannerWritesEnabled', () => {
  it('default false', () => {
    expect(plannerWritesEnabled()).toBe(false)
  })
  it('true sólo con "true"', () => {
    process.env.ASSISTANT_PLANNER_WRITES = 'true'
    expect(plannerWritesEnabled()).toBe(true)
    process.env.ASSISTANT_PLANNER_WRITES = '1'
    expect(plannerWritesEnabled()).toBe(false)
  })
})

describe('getPlannerDomains (re-export)', () => {
  it('voucher nunca entra', () => {
    process.env.ASSISTANT_PLANNER_DOMAINS = 'voucher,assistant'
    expect([...getPlannerDomains()]).toEqual(['assistant'])
  })
})
