import { describe, it, expect, afterEach } from 'vitest'
import { getPlannerMode, proposeActions, compareShadow, type PlannerRunResult } from './planner'
import { getPlannerDomains } from './policy'
import type { ToolCall } from '@/lib/ai/openrouter'

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: `c_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

function result(over: Partial<PlannerRunResult> = {}): PlannerRunResult {
  return { proposal: null, latencyMs: 10, modelUsed: 'test', ...over }
}

afterEach(() => {
  delete process.env.ASSISTANT_AGENT_PLANNER
  delete process.env.ASSISTANT_PLANNER_DOMAINS
})

describe('getPlannerMode', () => {
  it('default off', () => {
    expect(getPlannerMode()).toBe('off')
  })
  it('shadow / on', () => {
    process.env.ASSISTANT_AGENT_PLANNER = 'shadow'
    expect(getPlannerMode()).toBe('shadow')
    process.env.ASSISTANT_AGENT_PLANNER = 'on'
    expect(getPlannerMode()).toBe('on')
  })
  it('valor desconocido → off', () => {
    process.env.ASSISTANT_AGENT_PLANNER = 'yes'
    expect(getPlannerMode()).toBe('off')
  })
})

describe('getPlannerDomains', () => {
  it('default vacío', () => {
    expect(getPlannerDomains().size).toBe(0)
  })
  it('parsea csv y descarta desconocidos', () => {
    process.env.ASSISTANT_PLANNER_DOMAINS = 'assistant, pedido , voucher, bobada'
    const d = getPlannerDomains()
    expect([...d].sort()).toEqual(['assistant', 'pedido'])
  })
  it('voucher nunca entra', () => {
    process.env.ASSISTANT_PLANNER_DOMAINS = 'voucher'
    expect(getPlannerDomains().size).toBe(0)
  })
})

describe('proposeActions (LLM → acciones propuestas)', () => {
  it('registrar_gasto → run_expense y marca write', () => {
    const p = proposeActions([call('registrar_gasto', { texto: 'gasté 5000 en luz' })], 'gasté 5000 en luz', null)
    expect(p.writes).toEqual(['registrar_gasto'])
    expect(p.domains).toContain('expense')
    expect(p.actions[0].kind).toBe('run_expense')
    expect(p.confidence).toBe('alta')
  })

  it('registrar_asistencia → run_attendance', () => {
    const p = proposeActions([call('registrar_asistencia', { texto: 'llegó Juan 8:30' })], 'llegó Juan 8:30', null)
    expect(p.domains).toContain('attendance')
    expect(p.actions[0].kind).toBe('run_attendance')
  })

  it('cotizar_pedido → run_order, dominio pedido, sin write', () => {
    const p = proposeActions([call('cotizar_pedido', { texto: '2 bastidores 60x40' })], '2 bastidores 60x40', null)
    expect(p.domains).toContain('pedido')
    expect(p.writes).toEqual([])
    expect(p.actions[0].kind).toBe('run_order')
  })

  it('consultar_facturas → run_assistant (lectura)', () => {
    const p = proposeActions([call('consultar_facturas', { cliente: 'Marlon' })], 'cuánto debe Marlon', null)
    expect(p.domains).toContain('assistant')
    expect(p.writes).toEqual([])
    expect(p.actions[0].kind).toBe('run_assistant')
  })

  it('sin tool calls → reply_text', () => {
    const p = proposeActions([], 'hola qué tal', null)
    expect(p.actions[0].kind).toBe('reply_text')
    expect(p.confidence).toBe('baja')
  })

  it('máximo una escritura por turno', () => {
    const p = proposeActions(
      [call('registrar_gasto', { texto: 'x' }), call('registrar_asistencia', { texto: 'y' })],
      'x y',
      null,
    )
    expect(p.actions.filter((a) => a.kind === 'run_expense' || a.kind === 'run_attendance')).toHaveLength(1)
  })
})

describe('compareShadow', () => {
  it('coincide: det=expense y planner registra gasto', () => {
    const proposal = proposeActions([call('registrar_gasto', { texto: 'gasté 5000' })], 'gasté 5000', null)
    const c = compareShadow({ deterministicDomain: 'expense', deterministicReason: 'intent', result: result({ proposal }) })
    expect(c.agrees).toBe(true)
    expect(c.unnecessaryWrite).toBe(false)
    expect(c.missedWrite).toBe(false)
  })

  it('falso positivo de escritura: det=assistant y planner propone registrar gasto', () => {
    const proposal = proposeActions([call('registrar_gasto', { texto: 'x' })], 'x', null)
    const c = compareShadow({ deterministicDomain: 'assistant', deterministicReason: 'intent', result: result({ proposal }) })
    expect(c.unnecessaryWrite).toBe(true)
    expect(c.agrees).toBe(false)
  })

  it('escritura perdida: det=expense y planner sólo conversa', () => {
    const proposal = proposeActions([], 'pagué 5000', null)
    const c = compareShadow({ deterministicDomain: 'expense', deterministicReason: 'intent', result: result({ proposal }) })
    expect(c.missedWrite).toBe(true)
  })

  it('error del planner se registra sin romper', () => {
    const c = compareShadow({ deterministicDomain: 'assistant', deterministicReason: 'intent', result: result({ error: 'timeout' }) })
    expect(c.latched).toBe('error')
    expect(c.error).toBe('timeout')
  })

  it('off: no hay propuesta → no rompe la comparación', () => {
    const c = compareShadow({ deterministicDomain: 'none', deterministicReason: 'none', result: result({ error: 'planner_off' }) })
    expect(c.plannerDomains).toEqual([])
    expect(c.agrees).toBe(false)
    expect(c.applicable).toBe(false)
  })

  it('pedido acuerda por dominio y NO es missedWrite (no es escritura de tool)', () => {
    const proposal = proposeActions([call('cotizar_pedido', { texto: '2 bastidores 60x40' })], '2 bastidores 60x40', null)
    const c = compareShadow({ deterministicDomain: 'pedido', deterministicReason: 'intent', result: result({ proposal }) })
    expect(c.applicable).toBe(true)
    expect(c.agrees).toBe(true)
    expect(c.missedWrite).toBe(false)
    expect(c.unnecessaryWrite).toBe(false)
  })

  it('voucher queda fuera de alcance (no aplicable)', () => {
    const proposal = proposeActions([], 'Me pagó (cobro)', null)
    const c = compareShadow({ deterministicDomain: 'voucher', deterministicReason: 'clarify_resolve', result: result({ proposal }) })
    expect(c.applicable).toBe(false)
    expect(c.agrees).toBe(false)
  })
})
