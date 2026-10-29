import { describe, it, expect } from 'vitest'
import {
  AGENT_TOOLS,
  findAgentTool,
  agentToolDefinitions,
  listTools,
  queryFacturas,
  queryGastos,
  queryProveedores,
  queryEmpleados,
  queryCategorias,
  todayISO,
  type ToolContext,
} from './tool-registry'

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
    expect(findAgentTool('cotizar_pedido')?.write).toBeFalsy()
    expect(findAgentTool('registrar_gasto')?.write).toBe(true)
    expect(findAgentTool('no_existe')).toBeUndefined()
    const defs = agentToolDefinitions()
    expect(defs.length).toBe(AGENT_TOOLS.length)
    expect(defs[0].type).toBe('function')
  })

  it('includeWrites:false expone solo lecturas y meta (fallback read-only)', () => {
    const readOnly = agentToolDefinitions({ includeWrites: false })
    const writeNames = AGENT_TOOLS.filter((t) => t.write).map((t) => t.name)
    const exposed = readOnly.map((d) => d.function.name)
    expect(exposed.length).toBeGreaterThan(0)
    for (const name of writeNames) expect(exposed).not.toContain(name)
    expect(exposed).toContain('consultar_facturas')
    expect(exposed).toContain('pedir_ayuda')
  })

  it('kind coherente con write (Fase 1: catálogo único)', () => {
    for (const t of AGENT_TOOLS) {
      expect(['read', 'write', 'meta']).toContain(t.kind)
      expect(!!t.write).toBe(t.kind === 'write')
    }
    // Lecturas libres para el agente (Fase 1): incluye asistencia (nuevo hueco
    // cubierto) y ayuda meta. Voucher sigue fuera hasta el gate de Fase 2.
    const kinds = Object.fromEntries(AGENT_TOOLS.map((t) => [t.name, t.kind]))
    expect(kinds['consultar_asistencia']).toBe('read')
    expect(kinds['consultar_estado_pedido']).toBe('read')
    expect(kinds['consultar_confirmaciones_pendientes']).toBe('read')
    expect(kinds['consultar_ultima_escritura']).toBe('read')
    expect(kinds['pedir_ayuda']).toBe('meta')
    expect(kinds['registrar_gasto']).toBe('write')
    expect(kinds['registrar_asistencia']).toBe('write')
    // Fase 2: corrección (todas escriben, entran al gate en Fase 4).
    expect(kinds['editar_gasto']).toBe('write')
    expect(kinds['eliminar_gasto']).toBe('write')
    expect(kinds['eliminar_asistencia']).toBe('write')
    expect(kinds['deshacer_ultima_operacion']).toBe('write')
    expect(listTools()).toHaveLength(AGENT_TOOLS.length)
  })

  it('queries compartidas exportadas (fuente única con tools.ts)', () => {
    expect(typeof queryFacturas).toBe('function')
    expect(typeof queryGastos).toBe('function')
    expect(typeof queryProveedores).toBe('function')
    expect(typeof queryEmpleados).toBe('function')
    expect(typeof queryCategorias).toBe('function')
    expect(todayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('pedir_ayuda es pura (sin I/O) y lista el catálogo', async () => {
    const tool = findAgentTool('pedir_ayuda')!
    const out = await tool.execute({}, undefined as unknown as ToolContext)
    const data = out.data as { lecturas: string[]; escrituras: string[]; ayuda: string }
    expect(data.lecturas).toContain('consultar_asistencia')
    expect(data.escrituras).toContain('registrar_gasto')
    expect(data.ayuda.length).toBeGreaterThan(10)
  })

  it('consultar_estado_pedido devuelve el estado fresco de la conversación', async () => {
    const order = {
      stage: 'confirming',
      items: [
        {
          cantidad: 2,
          categoria: 'BASTIDOR',
          medida: '60x40',
          variante: 'Sin Tela',
          precio_unitario: 18000,
          faltante: false,
          descripcion: 'BASTIDOR 60 x 40 Sin Tela',
          regla_aplicada: null,
        },
      ],
      clienteNombre: 'Fede',
      total: 36000,
      faltantes: [],
      notaSupuestos: [],
      awaitingQuoteApproval: true,
      updatedAt: Date.now(),
    }
    const db = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { order_context: order } }) }) }),
      }),
    }
    const tool = findAgentTool('consultar_estado_pedido')!
    const out = await tool.execute({}, { db, conversationId: 'conv' } as unknown as ToolContext)
    const data = out.data as {
      abierto: boolean
      items: unknown[]
      total: number
      esperando: string | null
      cliente: string | null
    }
    expect(data.abierto).toBe(true)
    expect(data.items).toHaveLength(1)
    expect(data.total).toBe(36000)
    expect(data.cliente).toBe('Fede')
    expect(data.esperando).toContain('apruebe')
  })
})
