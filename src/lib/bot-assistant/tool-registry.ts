/**
 * Tools del agente conversacional (function calling).
 *
 * Cada tool envuelve funciones que YA existen (facbal/client + handlers
 * determinísticos de gastos/asistencia) para que el agente pueda consultar y
 * registrar. La ejecución real sigue siendo la de los handlers: el LLM solo
 * elige la tool y compone los argumentos.
 *
 * Pagos/vouchers NO se exponen acá: siguen por el pipeline determinístico.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  listExpenses,
  matchVoucherByName,
  searchProviders,
  listProviders,
  searchEmployees,
  listEmployees,
  listExpenseCategories,
} from '@/lib/facbal/client'
import { processExpenseMessage } from '@/lib/expenses'
import { processAttendanceMessage } from '@/lib/attendance'

export interface ToolContext {
  db: SupabaseClient
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  accessToken: string
  senderPhone: string
  senderName: string
  messageId?: string | null
}

export interface AgentToolResult {
  data: unknown
  summary: string
}

export interface AgentTool {
  name: string
  description: string
  /** JSON Schema de los parámetros. */
  parameters: Record<string, unknown>
  /** true para tools que escriben (registro). */
  write?: boolean
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<AgentToolResult>
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function todayISO(offsetDays = 0): string {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  return d.toISOString().slice(0, 10)
}

export const AGENT_TOOLS: AgentTool[] = [
  {
    name: 'consultar_facturas',
    description:
      'Consulta las facturas pendientes (saldo/deuda) de un cliente. Usala para "¿cuánto debe X?", "¿X tiene alguna factura?", "¿pagó X?".',
    parameters: {
      type: 'object',
      properties: {
        cliente: { type: 'string', description: 'Nombre del cliente a consultar.' },
      },
      required: ['cliente'],
    },
    execute: async (args) => {
      const cliente = str(args.cliente)
      if (!cliente) return { data: null, summary: 'Falta el nombre del cliente.' }
      const res = await matchVoucherByName({
        nombre_cliente: cliente,
        nombre_origen: cliente,
        nombre_destino: null,
        cbu_destino: null,
        cuit_destino: null,
        monto: 0,
        tolerancia: 999999999,
      })
      const invoices = (res.invoice_candidates || [])
        .map((c) => ({
          factura: c.numero_factura,
          cliente: c.cliente_nombre,
          saldo: c.saldo_pendiente,
          fecha: c.fecha,
        }))
        .slice(0, 10)
      const total = invoices.reduce((s, i) => s + (i.saldo || 0), 0)
      return {
        data: { cliente_buscado: cliente, invoices, total },
        summary: `${invoices.length} factura(s) para ${cliente}. Total ${total}.`,
      }
    },
  },
  {
    name: 'listar_gastos',
    description: 'Lista los gastos del negocio en un rango de fechas (por defecto hoy).',
    parameters: {
      type: 'object',
      properties: {
        desde: { type: 'string', description: 'Fecha YYYY-MM-DD (opcional).' },
        hasta: { type: 'string', description: 'Fecha YYYY-MM-DD (opcional).' },
      },
    },
    execute: async (args) => {
      const desde = str(args.desde) || todayISO()
      const hasta = str(args.hasta) || desde
      const data = await listExpenses({ from_date: desde, to_date: hasta, limit: 50 })
      return { data, summary: `Gastos ${desde}..${hasta}: ${Array.isArray(data) ? data.length : 0}.` }
    },
  },
  {
    name: 'buscar_proveedores',
    description: 'Busca proveedores por nombre, o los lista todos si no se pasa query.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
    },
    execute: async (args) => {
      const q = str(args.query)
      const data = q ? await searchProviders(q) : await listProviders()
      return { data, summary: `Proveedores: ${Array.isArray(data) ? data.length : 0}.` }
    },
  },
  {
    name: 'buscar_empleados',
    description: 'Busca empleados por nombre, o los lista todos si no se pasa query.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
    },
    execute: async (args) => {
      const q = str(args.query)
      const data = q ? await searchEmployees(q) : await listEmployees()
      return { data, summary: `Empleados: ${Array.isArray(data) ? data.length : 0}.` }
    },
  },
  {
    name: 'listar_categorias',
    description: 'Lista las categorías de gasto disponibles (útil para no inventar categorías).',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const data = await listExpenseCategories()
      return { data, summary: `Categorías: ${Array.isArray(data) ? data.length : 0}.` }
    },
  },
  {
    name: 'registrar_gasto',
    description:
      'Registra un gasto del negocio. Pasá en "texto" la frase natural con monto y concepto, ej: "gasté 5000 en luz". El handler determinístico lo parsea y lo registra.',
    parameters: {
      type: 'object',
      properties: {
        texto: { type: 'string', description: 'Frase natural del gasto a registrar.' },
      },
      required: ['texto'],
    },
    write: true,
    execute: async (args, ctx) => {
      const texto = str(args.texto)
      if (!texto) return { data: null, summary: 'Falta el detalle del gasto.' }
      const r = await processExpenseMessage({
        db: ctx.db,
        messageType: 'text',
        text: texto,
        accessToken: ctx.accessToken,
        senderPhone: ctx.senderPhone,
        senderName: ctx.senderName,
        accountId: ctx.accountId,
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        contactId: ctx.contactId,
        messageId: ctx.messageId ?? null,
      })
      return { data: r, summary: r.text || (r.handled ? 'Gasto procesado.' : 'No se pudo registrar.') }
    },
  },
  {
    name: 'registrar_asistencia',
    description:
      'Registra llegada/salida/estado de un empleado. Pasá en "texto" la frase natural, ej: "llegó Juan 8:30".',
    parameters: {
      type: 'object',
      properties: {
        texto: { type: 'string', description: 'Frase natural de asistencia.' },
      },
      required: ['texto'],
    },
    write: true,
    execute: async (args, ctx) => {
      const texto = str(args.texto)
      if (!texto) return { data: null, summary: 'Falta el detalle de la asistencia.' }
      const r = await processAttendanceMessage({
        db: ctx.db,
        text: texto,
        accountId: ctx.accountId,
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        contactId: ctx.contactId,
        messageId: ctx.messageId ?? null,
      })
      return { data: r, summary: r.error || (r.handled ? 'Asistencia procesada.' : 'No se pudo registrar.') }
    },
  },
]

export function findAgentTool(name: string): AgentTool | undefined {
  return AGENT_TOOLS.find((t) => t.name === name)
}

/** Definiciones OpenAI-compatible para pasar al modelo. */
export function agentToolDefinitions() {
  return AGENT_TOOLS.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }))
}
