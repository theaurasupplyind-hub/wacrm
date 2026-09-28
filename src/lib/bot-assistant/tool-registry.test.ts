import { describe, it, expect } from 'vitest'
import { AGENT_TOOLS, findAgentTool, agentToolDefinitions } from './tool-registry'

describe('agent tool registry', () => {
  it('nombres únicos y schemas object', () => {
    const names = AGENT_TOOLS.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    for (const t of AGENT_TOOLS) {
      expect(t.description.length).toBeGreaterThan(10)
      expect(t.parameters.type).toBe('object')
    }
  })

  it('expone defensa de pagos: no hay tool de pago/voucher', () => {
    const names = AGENT_TOOLS.map((t) => t.name)
    expect(names).not.toContain('registrar_pago')
    expect(names).not.toContain('registrar_voucher')
  })

  it('findAgentTool y definiciones', () => {
    expect(findAgentTool('consultar_facturas')?.write).toBeFalsy()
    expect(findAgentTool('registrar_gasto')?.write).toBe(true)
    expect(findAgentTool('no_existe')).toBeUndefined()
    const defs = agentToolDefinitions()
    expect(defs.length).toBe(AGENT_TOOLS.length)
    expect(defs[0].type).toBe('function')
  })
})
