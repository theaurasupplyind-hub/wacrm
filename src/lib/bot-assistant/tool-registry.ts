/**
 * Catálogo ÚNICO de tools del bot (Fase 1 del plan agente-conversacional).
 *
 * Cada tool envuelve funciones que YA existen (facbal/client + handlers
 * determinísticos de gastos/asistencia) para que el agente pueda consultar y
 * registrar. La ejecución real sigue siendo la de los handlers: el LLM solo
 * elige la tool y compone los argumentos.
 *
 * - `kind: 'read'` — lectura libre, sin fricción (nunca confirma).
 * - `kind: 'write'` — escritura; pasa por el gate de efectos (Fase 2:
 *   auto-save salvo ambiguo, ver `docs/bots/definicion-ambiguedad.md`).
 * - `kind: 'meta'` — ayuda/navegación, sin efectos sobre datos de negocio.
 *
 * `tools.ts` (vía del orquestador legacy) delega sus lecturas a estas mismas
 * `execute` para no duplicar lógica: una sola fuente de verdad de QUÉ hace
 * cada lectura. El ruteo (CUÁNDO llamar) sigue en cada vía hasta la Fase 4.
 *
 * Pagos/vouchers NO se exponen acá todavía: el pipeline de voucher tiene
 * efectos (envía mensajes, registra pagos) y entra con el gate de efectos
 * de la Fase 2, no antes.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { UnifiedExtraction } from '@/lib/bot-llm/types'
import {
  listExpenses,
  matchVoucherByName,
  searchProviders,
  listProviders,
  searchEmployees,
  listEmployees,
  getAttendance,
  deleteAttendance,
  listExpenseCategories,
  buscarProductos,
  updateExpense,
  deleteExpense,
  deleteInvoice,
  deletePayment,
} from '@/lib/facbal/client'
import { processExpenseMessage } from '@/lib/expenses'
import { processAttendanceMessage } from '@/lib/attendance'
import { previewPedido } from '@/lib/pedidos/preview'
import { loadGlossary } from '@/lib/pedidos/glossary'
import { loadOrderContext, isOrderContextActive, isResumableQuote } from '@/lib/pedidos/context'
import type { OrderContext } from '@/lib/pedidos/types'
import { evaluateGate, type OperationKind, type MatchInfo } from './effect-gate'
import {
  recordWrite,
  latestUndoableWrite,
  markUndone,
  resolveUndoAction,
  attendanceKey,
  parseAttendanceKey,
  type UndoHandle,
} from './undo-log'
import { resolveLatestPending } from './failure-trace'
import { createPendingConfirm, hasRecentConfirmation, peekFreshPending } from './pending-confirm'

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
  /** Extracción del turno (la setea el agente; habilita el gate en sombra). */
  extraction?: UnifiedExtraction | null
  /** Pre-match único del turno (lo calcula el agente; alimenta S3/S4). */
  preMatch?: MatchInfo | null
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
  /** true para tools que escriben (registro). Equivale a `kind === 'write'`. */
  write?: boolean
  /** Clase de tool: lectura libre, escritura con gate, o meta sin efectos. */
  kind: 'read' | 'write' | 'meta'
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<AgentToolResult>
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** Texto de confirmación cuando el gate exige revisar antes de guardar. */
function buildConfirmPreview(texto: string, operation: string, questions: string[]): string {
  const qs = questions.length > 0 ? ` ${questions.join(' ')}` : ''
  return `Revisá antes de guardar (${operation}): "${texto}".${qs} ¿Confirmás?`
}

export function todayISO(offsetDays = 0): string {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  return d.toISOString().slice(0, 10)
}

/** En qué paso está un pedido a medio armar (para el estado fresco del agente). */
function describeOrderAwaiting(s: OrderContext): string | null {
  if (s.awaitingOrderItems) return 'esperando los productos/medidas'
  if (s.awaitingQuoteApproval) return 'esperando que el usuario apruebe la cotización'
  if (s.awaitingGlossary) return 'esperando que explique un término del glosario'
  if (s.awaitingItemAttr) return 'esperando una medida/variante'
  if (s.awaitingCliente) return 'esperando el nombre del cliente'
  if (s.awaitingClienteChoice) return 'esperando que elija el cliente candidato'
  if (s.awaitingDatos) return 'esperando entrega + fecha + descuento'
  if (s.awaitingEntrega) return 'esperando el tipo de entrega'
  if (s.awaitingFecha) return 'esperando la fecha de entrega'
  if (s.awaitingDescuento) return 'esperando el descuento'
  if (s.awaitingDomicilio) return 'esperando el domicilio'
  return null
}

// ── Queries compartidas (fuente única) ──────────────────────────────
// Lógica de QUÉ consultar, sin envelope de presentación. Las usan tanto
// las `execute` de abajo (envelope: {data, summary} para el agente) como
// `tools.ts` (envelope: {data, log} con withTiming para el orquestador
// legacy). Agregar una lectura = agregarla acá + una tool abajo.

export interface FacturaCandidata {
  factura: string
  cliente: string
  saldo: number
  fecha: string
  score: number | null
}

export interface DeudaCliente {
  cliente_buscado: string
  invoices: FacturaCandidata[]
  total: number
}

export async function queryFacturas(cliente: string): Promise<DeudaCliente> {
  const res = await matchVoucherByName({
    nombre_cliente: cliente,
    nombre_origen: cliente,
    nombre_destino: null,
    cbu_destino: null,
    cuit_destino: null,
    monto: 0,
    tolerancia: 999999999,
  })
  const invoices: FacturaCandidata[] = (res.invoice_candidates || [])
    .map((c) => ({
      factura: c.numero_factura,
      cliente: c.cliente_nombre,
      saldo: c.saldo_pendiente,
      fecha: c.fecha,
      // score lo usa la vía legacy (prompts: confirmar si hay parecidos
      // o score bajo); se mantiene acá para unificar el shape.
      score: (c as { score?: number }).score ?? null,
    }))
    .slice(0, 10)
  const total = invoices.reduce((s, i) => s + (i.saldo || 0), 0)
  return { cliente_buscado: cliente, invoices, total }
}

export async function queryGastos(desde: string, hasta: string): Promise<unknown> {
  return listExpenses({ from_date: desde, to_date: hasta, limit: 50 })
}

export async function queryProveedores(query: string | null): Promise<unknown> {
  return query ? searchProviders(query) : listProviders()
}

export async function queryEmpleados(query: string | null): Promise<unknown> {
  return query ? searchEmployees(query) : listEmployees()
}

export async function queryCategorias(): Promise<unknown> {
  return listExpenseCategories()
}

export const AGENT_TOOLS: AgentTool[] = [
  {
    name: 'consultar_facturas',
    kind: 'read',
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
      const data = await queryFacturas(cliente)
      return {
        data,
        summary: `${data.invoices.length} factura(s) para ${cliente}. Total ${data.total}.`,
      }
    },
  },
  {
    name: 'listar_gastos',
    kind: 'read',
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
      const data = await queryGastos(desde, hasta)
      return { data, summary: `Gastos ${desde}..${hasta}: ${Array.isArray(data) ? (data as unknown[]).length : 0}.` }
    },
  },
  {
    name: 'buscar_proveedores',
    kind: 'read',
    description: 'Busca proveedores por nombre, o los lista todos si no se pasa query.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
    },
    execute: async (args) => {
      const q = str(args.query)
      const data = await queryProveedores(q)
      return { data, summary: `Proveedores: ${Array.isArray(data) ? (data as unknown[]).length : 0}.` }
    },
  },
  {
    name: 'buscar_empleados',
    kind: 'read',
    description: 'Busca empleados por nombre, o los lista todos si no se pasa query.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
    },
    execute: async (args) => {
      const q = str(args.query)
      const data = await queryEmpleados(q)
      return { data, summary: `Empleados: ${Array.isArray(data) ? (data as unknown[]).length : 0}.` }
    },
  },
  {
    name: 'listar_categorias',
    kind: 'read',
    description: 'Lista las categorías de gasto disponibles (útil para no inventar categorías).',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const data = await queryCategorias()
      return { data, summary: `Categorías: ${Array.isArray(data) ? (data as unknown[]).length : 0}.` }
    },
  },
  {
    name: 'buscar_productos',
    kind: 'read',
    description:
      'Busca productos del catálogo (bastidores, telas, medidas, variantes) por texto. Usala para "¿tenés boxy fit lisas?", "precio de un bastidor 60x40", consultas de catálogo.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Texto de búsqueda del producto (ej: "boxy fit lisas", "bastidor 60x40").' },
      },
      required: ['query'],
    },
    execute: async (args) => {
      const q = str(args.query)
      if (!q) return { data: null, summary: 'Falta el texto de búsqueda.' }
      const data = await buscarProductos(q)
      return { data, summary: `Productos: ${Array.isArray(data) ? data.length : 0}.` }
    },
  },
  {
    name: 'cotizar_pedido',
    kind: 'read',
    description:
      'Cotiza un pedido/presupuesto a partir de una frase natural con medidas o productos (ej: "56 x 78, 89 x 67 sin tela", "2 bastidores 60x40", "una pintura 94x81"). Devuelve ítems con precio, los supuestos asumidos y los faltantes sin cotizar. NO crea el presupuesto: solo cotiza. Usala para armar/ver un presupuesto.',
    parameters: {
      type: 'object',
      properties: {
        texto: { type: 'string', description: 'Frase natural del pedido (medidas/productos).' },
      },
      required: ['texto'],
    },
    execute: async (args, ctx) => {
      const texto = str(args.texto)
      if (!texto) return { data: null, summary: 'Falta el texto del pedido.' }
      // Glosario de la cuenta: sin esto el preview no reconoce sinónimos ni
      // productos aprendidos y cotiza distinto que el flujo real.
      const glossary = await loadGlossary(ctx.db, ctx.accountId)
      const preview = await previewPedido(texto, { glossary })
      if (!preview) return { data: null, summary: 'No se detectaron ítems para cotizar.' }
      return { data: preview, summary: preview.text }
    },
  },
  {
    name: 'consultar_estado_pedido',
    kind: 'read',
    description:
      'Devuelve el estado REAL del pedido/presupuesto de ESTA conversación (ítems cotizados, total, cliente, entrega, fecha, descuento, si está esperando algo, o si está descartado y es reanudable). Usala SIEMPRE antes de hablar de un presupuesto en curso. NUNCA reconstruyas este estado desde el historial.',
    parameters: { type: 'object', properties: {} },
    execute: async (_args, ctx) => {
      const state = await loadOrderContext(ctx.db, ctx.conversationId)
      if (!state || state.stage !== 'confirming') {
        return {
          data: { abierto: false, reanudable: false, descartado: false, items: [] },
          summary: 'No hay un pedido abierto en esta conversación.',
        }
      }
      const abierto = isOrderContextActive(state)
      const reanudable = isResumableQuote(state)
      const items = state.items
        .filter((i) => !i.faltante)
        .map((i) => ({ cantidad: i.cantidad, descripcion: i.descripcion, precio_unitario: i.precio_unitario }))
      const data = {
        abierto,
        reanudable,
        descartado: !!state.quoteCancelled,
        items,
        faltantes: state.faltantes,
        total: state.total,
        cliente: state.clienteNombre ?? null,
        tipoEntrega: state.tipoEntrega ?? null,
        fechaEntrega: state.fechaEntrega ?? null,
        descuento: state.descuento ?? null,
        esperando: describeOrderAwaiting(state),
      }
      const estado = abierto ? 'abierto' : reanudable ? 'descartado (reanudable)' : 'inactivo'
      return { data, summary: `Pedido ${estado}: ${items.length} ítem(s), total ${state.total}.` }
    },
  },
  {
    name: 'consultar_confirmaciones_pendientes',
    kind: 'read',
    description:
      'Devuelve la confirmación pendiente de esta conversación (operación + preview), si hay. Usala antes de decir que algo quedó pendiente de confirmar.',
    parameters: { type: 'object', properties: {} },
    execute: async (_args, ctx) => {
      const p = await peekFreshPending(ctx.db, ctx.conversationId)
      return p
        ? { data: { pendiente: true, tool: p.tool, preview: p.preview }, summary: `Pendiente de confirmar: ${p.preview ?? p.tool}` }
        : { data: { pendiente: false }, summary: 'No hay confirmaciones pendientes.' }
    },
  },
  {
    name: 'consultar_ultima_escritura',
    kind: 'read',
    description:
      'Devuelve la última operación que el bot REGISTRÓ en esta conversación (dentro de 24h): entidad y resumen. Usala para no afirmar algo que no se registró.',
    parameters: { type: 'object', properties: {} },
    execute: async (_args, ctx) => {
      const row = await latestUndoableWrite(ctx.db, ctx.conversationId)
      return row
        ? {
            data: { entidad: row.entity, resumen: row.summary, id: row.id, creada: row.created_at },
            summary: `Última operación registrada: ${row.summary ?? row.entity}`,
          }
        : { data: { ninguna: true }, summary: 'No hay escrituras recientes (24h).' }
    },
  },
  {
    name: 'registrar_gasto',
    kind: 'write',
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
      // Fase 4: el gate EXIGE. Si pide confirmar y no hay confirmación válida,
      // se guarda pendiente y se devuelve preview (no se ejecuta).
      const gate = evaluateGate({
        text: texto,
        extraction: ctx.extraction ?? null,
        operation: 'gasto' as OperationKind,
        match: ctx.preMatch ?? undefined,
      })
      let confirmed = (args as { _confirmed?: boolean })._confirmed === true
      if (confirmed) {
        confirmed = await hasRecentConfirmation(ctx.db, ctx.conversationId, 'registrar_gasto')
        if (!confirmed) {
          console.log('[gate:bypass-denied] tool=registrar_gasto sin pending consumido — se evalúa normal')
        }
      }
      if (gate.decision === 'confirma' && !confirmed) {
        const preview = buildConfirmPreview(texto, 'gasto', gate.questions)
        const pendingId = await createPendingConfirm(ctx.db, {
          account_id: ctx.accountId,
          conversation_id: ctx.conversationId,
          contact_id: ctx.contactId,
          tool: 'registrar_gasto',
          toolArgs: { texto },
          preview,
        })
        console.log(
          '[gate:hold] tool=registrar_gasto reasons=%s pending=%s',
          gate.reasons.join(',') || 'none',
          pendingId,
        )
        return {
          data: { confirmation_required: true, gate, pending_id: pendingId, preview },
          summary: preview,
        }
      }
      console.log(
        '[gate:allow] tool=registrar_gasto reasons=%s confirmed=%s',
        gate.reasons.join(',') || 'none',
        confirmed,
      )
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
      console.log(
        '[gate:executed] tool=registrar_gasto handled=%s expenseId=%s',
        r.handled,
        r.expenseId ?? null,
      )
      let undo: UndoHandle | null = null
      if (r.handled && r.expenseId) {
        undo = await recordWrite(ctx.db, {
          account_id: ctx.accountId,
          conversation_id: ctx.conversationId,
          contact_id: ctx.contactId,
          entity: 'gasto',
          entity_id: r.expenseId,
          summary: r.text ?? texto,
        })
      }
      return {
        data: { ...r, gate, undo },
        summary: r.text || (r.handled ? 'Gasto procesado.' : 'No se pudo registrar.'),
      }
    },
  },
  {
    name: 'registrar_asistencia',
    kind: 'write',
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
      // Fase 4: el gate EXIGE. Si pide confirmar y no hay confirmación válida,
      // se guarda pendiente y se devuelve preview (no se ejecuta).
      const gate = evaluateGate({
        text: texto,
        extraction: ctx.extraction ?? null,
        operation: 'asistencia' as OperationKind,
        match: ctx.preMatch ?? undefined,
      })
      let confirmed = (args as { _confirmed?: boolean })._confirmed === true
      if (confirmed) {
        confirmed = await hasRecentConfirmation(ctx.db, ctx.conversationId, 'registrar_asistencia')
        if (!confirmed) {
          console.log('[gate:bypass-denied] tool=registrar_asistencia sin pending consumido — se evalúa normal')
        }
      }
      if (gate.decision === 'confirma' && !confirmed) {
        const preview = buildConfirmPreview(texto, 'asistencia', gate.questions)
        const pendingId = await createPendingConfirm(ctx.db, {
          account_id: ctx.accountId,
          conversation_id: ctx.conversationId,
          contact_id: ctx.contactId,
          tool: 'registrar_asistencia',
          toolArgs: { texto },
          preview,
        })
        console.log(
          '[gate:hold] tool=registrar_asistencia reasons=%s pending=%s',
          gate.reasons.join(',') || 'none',
          pendingId,
        )
        return {
          data: { confirmation_required: true, gate, pending_id: pendingId, preview },
          summary: preview,
        }
      }
      console.log(
        '[gate:allow] tool=registrar_asistencia reasons=%s confirmed=%s',
        gate.reasons.join(',') || 'none',
        confirmed,
      )
      const r = await processAttendanceMessage({
        db: ctx.db,
        text: texto,
        accountId: ctx.accountId,
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        contactId: ctx.contactId,
        messageId: ctx.messageId ?? null,
      })
      const rec = r as { handled?: boolean; employeeName?: unknown; date?: unknown; error?: unknown }
      console.log('[gate:executed] tool=registrar_asistencia handled=%s', rec.handled)
      let undo: UndoHandle | null = null
      if (rec.handled && !rec.error && typeof rec.employeeName === 'string' && typeof rec.date === 'string') {
        undo = await recordWrite(ctx.db, {
          account_id: ctx.accountId,
          conversation_id: ctx.conversationId,
          contact_id: ctx.contactId,
          entity: 'asistencia',
          entity_key: attendanceKey(rec.employeeName, rec.date),
          summary: `Asistencia ${rec.employeeName} ${rec.date}`,
        })
      }
      return {
        data: { ...rec, gate, undo },
        summary:
          typeof rec.error === 'string' && rec.error
            ? rec.error
            : rec.handled
              ? 'Asistencia procesada.'
              : 'No se pudo registrar.',
      }
    },
  },
  {
    name: 'consultar_asistencia',
    kind: 'read',
    description:
      'Consulta la asistencia registrada de un empleado en una fecha (YYYY-MM-DD, por defecto hoy). Usala para "¿vino Juan hoy?", "¿quién faltó ayer?", "¿a qué hora llegó X?".',
    parameters: {
      type: 'object',
      properties: {
        empleado: { type: 'string', description: 'Nombre del empleado.' },
        fecha: { type: 'string', description: 'Fecha YYYY-MM-DD (opcional, por defecto hoy).' },
      },
      required: ['empleado'],
    },
    execute: async (args) => {
      const nombre = str(args.empleado)
      if (!nombre) return { data: null, summary: 'Falta el nombre del empleado.' }
      const fecha = str(args.fecha) || todayISO()
      const matches = await searchEmployees(nombre)
      const emp = (matches || [])[0] as { id: number; name: string } | undefined
      if (!emp) return { data: null, summary: `No encontré al empleado "${nombre}".` }
      const records = await getAttendance(emp.id, fecha)
      return {
        data: { empleado: emp.name, employee_id: emp.id, fecha, records },
        summary: `Asistencia de ${emp.name} el ${fecha}: ${Array.isArray(records) ? records.length : 0} registro(s).`,
      }
    },
  },
  {
    name: 'editar_gasto',
    kind: 'write',
    description:
      'Edita un gasto ya registrado (monto, descripción, fecha o categoría). Necesitás el expense_id (sale del UndoHandle, del historial o de listar_gastos). Para la categoría pasá el category_id (ver listar_categorias).',
    parameters: {
      type: 'object',
      properties: {
        expense_id: { type: 'number', description: 'ID del gasto a editar.' },
        monto: { type: 'number', description: 'Nuevo monto (opcional).' },
        descripcion: { type: 'string', description: 'Nueva descripción (opcional).' },
        fecha: { type: 'string', description: 'Nueva fecha YYYY-MM-DD (opcional).' },
        categoria_id: { type: 'number', description: 'Nueva categoría (opcional).' },
      },
      required: ['expense_id'],
    },
    write: true,
    execute: async (args, ctx) => {
      const id = typeof args.expense_id === 'number' ? args.expense_id : Number(args.expense_id)
      if (!Number.isFinite(id)) return { data: null, summary: 'Falta un expense_id válido.' }
      const payload: Record<string, unknown> = {}
      if (typeof args.monto === 'number') payload.amount = args.monto
      if (typeof args.descripcion === 'string' && args.descripcion.trim()) {
        payload.description = args.descripcion.trim()
      }
      if (typeof args.fecha === 'string' && args.fecha.trim()) payload.date = args.fecha.trim()
      if (typeof args.categoria_id === 'number') payload.category_id = args.categoria_id
      if (Object.keys(payload).length === 0) {
        return { data: null, summary: 'Nada para editar: pasá monto, descripcion, fecha o categoria_id.' }
      }
      const updated = await updateExpense(id, payload)
      await resolveLatestPending(ctx.db, ctx.conversationId, 'editado', `gasto #${id}`)
      return { data: updated, summary: `Gasto #${id} actualizado.` }
    },
  },
  {
    name: 'eliminar_gasto',
    kind: 'write',
    description:
      'Elimina un gasto registrado (borrado lógico con reversión en cascada en el backend). Necesitás el expense_id.',
    parameters: {
      type: 'object',
      properties: {
        expense_id: { type: 'number', description: 'ID del gasto a eliminar.' },
      },
      required: ['expense_id'],
    },
    write: true,
    execute: async (args, ctx) => {
      const id = typeof args.expense_id === 'number' ? args.expense_id : Number(args.expense_id)
      if (!Number.isFinite(id)) return { data: null, summary: 'Falta un expense_id válido.' }
      const res = await deleteExpense(id)
      await resolveLatestPending(ctx.db, ctx.conversationId, 'deshecho', `gasto #${id}`)
      return { data: res, summary: `Gasto #${id} eliminado.` }
    },
  },
  {
    name: 'eliminar_asistencia',
    kind: 'write',
    description:
      'Elimina el registro de asistencia de un empleado en una fecha (para corregir se vuelve a registrar).',
    parameters: {
      type: 'object',
      properties: {
        empleado: { type: 'string', description: 'Nombre del empleado.' },
        fecha: { type: 'string', description: 'Fecha YYYY-MM-DD (opcional, por defecto hoy).' },
      },
      required: ['empleado'],
    },
    write: true,
    execute: async (args, ctx) => {
      const nombre = str(args.empleado)
      if (!nombre) return { data: null, summary: 'Falta el nombre del empleado.' }
      const fecha = str(args.fecha) || todayISO()
      const matches = await searchEmployees(nombre)
      const emp = (matches || [])[0] as { id: number; name: string } | undefined
      if (!emp) return { data: null, summary: `No encontré al empleado "${nombre}".` }
      const res = await deleteAttendance(emp.id, fecha)
      await resolveLatestPending(ctx.db, ctx.conversationId, 'deshecho', `asistencia ${emp.name} ${fecha}`)
      return { data: res, summary: `Asistencia de ${emp.name} el ${fecha} eliminada.` }
    },
  },
  {
    name: 'deshacer_ultima_operacion',
    kind: 'write',
    description:
      'Deshace la última escritura del bot en esta conversación dentro de la ventana de 24h ("te equivocaste", "cancelá eso"). Usala cuando el usuario corrige o anula lo recién hecho.',
    parameters: { type: 'object', properties: {} },
    write: true,
    execute: async (_args, ctx) => {
      const row = await latestUndoableWrite(ctx.db, ctx.conversationId)
      if (!row) {
        return { data: null, summary: 'No hay operaciones recientes para deshacer (ventana 24h).' }
      }
      const action = resolveUndoAction(row)
      if (!action) {
        return { data: null, summary: 'No sé cómo deshacer esa operación.' }
      }
      if (action.entity === 'gasto' && action.entity_id != null) {
        const res = await deleteExpense(action.entity_id)
        await markUndone(ctx.db, row.id)
        await resolveLatestPending(ctx.db, ctx.conversationId, 'deshecho', `gasto #${action.entity_id}`)
        return { data: res, summary: `Deshecho: gasto #${action.entity_id} eliminado.` }
      }
      if (action.entity === 'factura' && action.entity_id != null) {
        const res = await deleteInvoice(action.entity_id)
        await markUndone(ctx.db, row.id)
        await resolveLatestPending(ctx.db, ctx.conversationId, 'deshecho', `factura #${action.entity_id}`)
        return { data: res, summary: `Deshecho: factura #${action.entity_id} anulada.` }
      }
      if (action.entity === 'pago' && action.entity_id != null) {
        const res = await deletePayment(action.entity_id)
        await markUndone(ctx.db, row.id)
        await resolveLatestPending(ctx.db, ctx.conversationId, 'deshecho', `pago #${action.entity_id}`)
        return { data: res, summary: `Deshecho: pago #${action.entity_id} eliminado.` }
      }
      if (action.entity === 'asistencia' && action.entity_key) {
        const parsed = parseAttendanceKey(action.entity_key)
        if (!parsed) return { data: null, summary: 'No pude interpretar el registro a deshacer.' }
        const matches = await searchEmployees(parsed.empleado)
        const emp = (matches || [])[0] as { id: number; name: string } | undefined
        if (!emp) return { data: null, summary: `No encontré al empleado "${parsed.empleado}".` }
        const res = await deleteAttendance(emp.id, parsed.fecha)
        await markUndone(ctx.db, row.id)
        await resolveLatestPending(ctx.db, ctx.conversationId, 'deshecho', `asistencia ${emp.name} ${parsed.fecha}`)
        return { data: res, summary: `Deshecho: asistencia de ${emp.name} el ${parsed.fecha} eliminada.` }
      }
      return { data: null, summary: 'No sé cómo deshacer esa operación.' }
    },
  },
  {
    name: 'pedir_ayuda',
    kind: 'meta',
    description:
      'Explica qué puede hacer el asistente (gastos, asistencia, deudas, presupuestos, pagos). Usala cuando el usuario pregunta qué sabés hacer o pide ayuda.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const byKind = (k: AgentTool['kind']) =>
        AGENT_TOOLS.filter((t) => t.kind === k && t.name !== 'pedir_ayuda').map((t) => t.name)
      const data = {
        lecturas: byKind('read'),
        escrituras: byKind('write'),
        ayuda: 'Puedo consultar y registrar gastos, llegadas/salidas, deudas de clientes, precios y presupuestos. Decime qué necesitás con tus palabras.',
      }
      return { data, summary: 'Capacidades del asistente.' }
    },
  },
]

export function findAgentTool(name: string): AgentTool | undefined {
  return AGENT_TOOLS.find((t) => t.name === name)
}

/** Catálogo resumido (nombre + clase) para prompts e introspección. */
export function listTools(): { name: string; kind: AgentTool['kind']; description: string }[] {
  return AGENT_TOOLS.map((t) => ({ name: t.name, kind: t.kind, description: t.description }))
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
