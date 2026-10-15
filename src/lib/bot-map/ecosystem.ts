/**
 * Mapa estático del ecosistema de bots de wacrm.
 *
 * Es un dato puro (serializable) que describe, de punta a punta, cómo se
 * conecta un mensaje entrante con los sistemas del fork: WhatsApp → webhook →
 * gates → motor de turno (extractor/Jev/router/planner) → handlers → agente y
 * tools → backend_gal / Supabase → galv2-tauri.
 *
 * A diferencia de `bot-trace/topology.ts` (que modela el recorrido de UN
 * mensaje y se pinta con trazas reales), este grafo es el **panorama completo**
 * con el estado de cada pieza (`active` / `beta` / `off` / `retired`) para
 * entender qué está en producción, qué está en prueba y qué está apagado.
 *
 * Fuente: `docs/bots/*` (architecture, assistant-agent, catalogo-acciones,
 * notas-fallos-reales) y las envs/flags del código. Al mover una pieza, actualizar
 * acá: es la vista que el equipo usa para decidir qué cambiar.
 */

export type EcosystemStatus = 'active' | 'beta' | 'off' | 'retired'

export type EcosystemGroup =
  | 'ingress'
  | 'gate'
  | 'brain'
  | 'handler'
  | 'agent'
  | 'system'
  | 'data'
  | 'external'

export interface EcosystemNode {
  id: string
  label: string
  group: EcosystemGroup
  status: EcosystemStatus
  description: string
  /** Archivos clave del fork. */
  files?: string[]
  /** Envs / flags relevantes. */
  env?: string[]
}

export interface EcosystemEdge {
  id: string
  source: string
  target: string
  label?: string
}

export const STATUS_META: Record<
  EcosystemStatus,
  { label: string; color: string; description: string }
> = {
  active: {
    label: 'Activo',
    color: '#10b981',
    description: 'En producción, funciona.',
  },
  beta: {
    label: 'En prueba',
    color: '#f59e0b',
    description: 'Código listo pero sin validar / en modo prueba.',
  },
  off: {
    label: 'Deshabilitado',
    color: '#94a3b8',
    description: 'Existe pero apagado por flag.',
  },
  retired: {
    label: 'Retirado',
    color: '#ef4444',
    description: 'Se quitó del código; no usar.',
  },
}

export const GROUP_META: Record<EcosystemGroup, { label: string }> = {
  ingress: { label: 'Entrada' },
  gate: { label: 'Gate' },
  brain: { label: 'Cerebro' },
  handler: { label: 'Handler' },
  agent: { label: 'Agente' },
  system: { label: 'Sistema' },
  data: { label: 'Datos' },
  external: { label: 'Externo' },
}

export const ECOSYSTEM: {
  nodes: EcosystemNode[]
  edges: EcosystemEdge[]
} = {
  nodes: [
    // ── Entrada ────────────────────────────────────────────────────────────
    {
      id: 'whatsapp',
      label: 'WhatsApp Cloud API',
      group: 'external',
      status: 'active',
      description: 'Mensajes entrantes del número conectado (Meta Cloud API).',
    },
    {
      id: 'webhook',
      label: 'Webhook entrante',
      group: 'ingress',
      status: 'active',
      description:
        'POST /api/whatsapp/webhook: persiste el mensaje, resuelve cuenta/remitente y arranca processMessage.',
      files: ['src/app/api/whatsapp/webhook/route.ts'],
    },

    // ── Gates (antes de decidir) ─────────────────────────────────────────
    {
      id: 'whitelist',
      label: 'Whitelist de números',
      group: 'gate',
      status: 'active',
      description:
        'Solo los números en bot_allowed_numbers entran al bot interno; el resto sigue por Flows/AI Auto-Reply. Fail-open si falta la tabla.',
      files: ['src/lib/bot/whitelist.ts'],
      env: ['tabla bot_allowed_numbers'],
    },
    {
      id: 'pending_confirm',
      label: 'Confirmaciones pendientes',
      group: 'gate',
      status: 'active',
      description:
        'Respuestas a botones/confirmaciones de gastos, asistencia, voucher y pedidos; se interceptan antes de Flows.',
      files: ['src/lib/bot-assistant/pending-confirm.ts'],
    },
    {
      id: 'media',
      label: 'Imagen / PDF',
      group: 'gate',
      status: 'active',
      description:
        'Remitente autorizado con imagen/documento → pipeline de voucher (visión).',
    },
    {
      id: 'audio',
      label: 'Audio',
      group: 'gate',
      status: 'active',
      description:
        'Transcripción con Whisper; después comparte el flujo de texto.',
      files: ['src/lib/audio/transcribe.ts'],
      env: ['openai/whisper-1'],
    },
    {
      id: 'context_cmd',
      label: 'cancelar / reiniciar',
      group: 'gate',
      status: 'active',
      description:
        'Comandos globales que limpian contextos (gasto, asistencia, voucher, pedido, aclaración).',
      files: ['src/lib/bot/context-command.ts'],
    },

    // ── Cerebro ──────────────────────────────────────────────────────────
    {
      id: 'engine',
      label: 'Motor de turno',
      group: 'brain',
      status: 'active',
      description:
        'planTurn: contexto → extracción → clarify → router → acciones. route.ts quedó como adapter que materializa el I/O.',
      files: ['src/lib/bot/engine.ts', 'src/lib/bot/policy.ts'],
    },
    {
      id: 'extract',
      label: 'Extracción LLM',
      group: 'brain',
      status: 'active',
      description:
        'extractBotMessage → intent + campos estructurados, con fallback regex.',
      files: ['src/lib/bot-llm/extract-bot-message.ts'],
      env: ['EXTRACTOR_MODEL'],
    },
    {
      id: 'jev',
      label: 'Jev (System One)',
      group: 'brain',
      status: 'beta',
      description:
        'Auxiliar de clasificación de intent y ruteo de pendientes. Default shadow: corre y loguea, NO decide. Sin validar en producción.',
      files: ['src/lib/ai/jev.ts', 'src/lib/bot-llm/classify-jev.ts'],
      env: ['JEV_ENABLED', 'JEV_SHADOW', 'JEV_MODEL'],
    },
    {
      id: 'router',
      label: 'Router (decideDispatch)',
      group: 'brain',
      status: 'active',
      description: 'Función pura: estado + extracción → dispatched_to.',
      files: ['src/lib/bot/router.ts'],
    },
    {
      id: 'planner',
      label: 'Planner LLM',
      group: 'brain',
      status: 'off',
      description:
        'Propone TurnActions; el runtime las valida (reconcilePlans + policy). Default off; se habilita por dominio.',
      files: ['src/lib/bot/planner.ts'],
      env: [
        'ASSISTANT_AGENT_PLANNER',
        'ASSISTANT_PLANNER_DOMAINS',
        'ASSISTANT_PLANNER_WRITES',
      ],
    },

    // ── Handlers (destinos del dispatch) ─────────────────────────────────
    {
      id: 'h_expense',
      label: 'Gastos',
      group: 'handler',
      status: 'active',
      description:
        'Texto/audio/imagen → expenses + movimientos. Confirmación solo por ambigüedad.',
      files: ['src/lib/expenses/'],
    },
    {
      id: 'h_attendance',
      label: 'Asistencia',
      group: 'handler',
      status: 'active',
      description:
        'Llegada/salida/estados con dedupe y multi-turno (empleado a resolver).',
      files: ['src/lib/attendance/'],
    },
    {
      id: 'h_voucher',
      label: 'Voucher',
      group: 'handler',
      status: 'active',
      description:
        'Extracción por visión + matching por fases + registro de pago cuando hay match confiable.',
      files: ['src/lib/ai/voucher-pipeline.ts'],
    },
    {
      id: 'h_pedido',
      label: 'Pedidos / presupuestos',
      group: 'handler',
      status: 'active',
      description:
        'Cotización (read-only) → confirmación → POST /invoices. Es la ruta vigente; reemplaza a Voice Orders.',
      files: ['src/lib/pedidos/'],
    },
    {
      id: 'h_assistant',
      label: 'Asistente',
      group: 'handler',
      status: 'active',
      description:
        'runAssistantForWebhook: agente con tools sobre historial + KB.',
      files: ['src/lib/bot-assistant/production.ts'],
    },
    {
      id: 'h_none',
      label: 'Sin dominio',
      group: 'handler',
      status: 'active',
      description: 'No hay dominio claro: cae al asistente / fallback.',
    },

    // ── Agente interno ───────────────────────────────────────────────────
    {
      id: 'agent',
      label: 'Agente (loop de tools)',
      group: 'agent',
      status: 'active',
      description:
        'runAssistantAgent: selecciona tools, recibe resultados y redacta la respuesta.',
      files: ['src/lib/bot-assistant/agent.ts'],
      env: ['ASSISTANT_MODEL', 'ASSISTANT_TOOLS_ENABLED'],
    },
    {
      id: 'tools',
      label: 'Tool registry',
      group: 'agent',
      status: 'active',
      description:
        'Leer facturas/gastos/proveedores/empleados/catálogo; cotizar pedidos; registrar gasto/asistencia (vía handlers).',
      files: ['src/lib/bot-assistant/tool-registry.ts'],
    },
    {
      id: 'kb',
      label: 'Base de conocimiento',
      group: 'agent',
      status: 'active',
      description:
        'retrieveKnowledge híbrido (pgvector + full-text search), por cuenta.',
      files: ['src/lib/ai/knowledge.ts'],
    },

    // ── Sistemas paralelos del webhook ───────────────────────────────────
    {
      id: 'flows',
      label: 'Flows Engine',
      group: 'system',
      status: 'off',
      description:
        'Bot builder visual. Prioridad #1 cuando está prendido; si un flujo consume el mensaje, suprime el resto.',
      files: ['src/lib/flows/engine.ts'],
      env: ['FLOWS_ENABLED'],
    },
    {
      id: 'automations',
      label: 'Automations',
      group: 'system',
      status: 'active',
      description: 'Reglas automáticas que corren al final del webhook.',
      files: ['src/lib/automations/'],
    },
    {
      id: 'ai_autoreply',
      label: 'AI Auto-Reply',
      group: 'system',
      status: 'active',
      description:
        'Respuestas IA a clientes, por cuenta (OpenAI/Anthropic). Fallback del asistente. Sistema separado del bot interno.',
      files: ['src/lib/ai/auto-reply.ts'],
    },
    {
      id: 'chatbot_legacy',
      label: 'Chatbot GAL (legado)',
      group: 'system',
      status: 'off',
      description:
        'Monolito reglas+LLM de pedidos. CHATBOT_ENABLED=false; refactor incompleto. No reactivar como atajo.',
      files: ['src/lib/ai/chatbot.ts'],
      env: ['CHATBOT_ENABLED'],
    },
    {
      id: 'voice_orders',
      label: 'Voice Orders (retirado)',
      group: 'system',
      status: 'retired',
      description:
        'Pipeline de pedidos por voz retirado del código (migración 049). La ruta vigente es pedidos/.',
      files: ['src/lib/pedidos/ (reemplazo)'],
    },

    // ── Datos / infra ────────────────────────────────────────────────────
    {
      id: 'openrouter',
      label: 'OpenRouter',
      group: 'data',
      status: 'active',
      description:
        'LLM + visión + Whisper + Jev (Decisions API). Todo el bot interno usa esta key.',
      env: ['OPENROUTER_API_KEY'],
    },
    {
      id: 'supabase',
      label: 'Supabase (Postgres)',
      group: 'data',
      status: 'active',
      description:
        'Mensajes, contextos multi-turno, logs del router, trazas y base de conocimiento.',
    },
    {
      id: 'backend_gal',
      label: 'backend_gal (FacBal API)',
      group: 'data',
      status: 'active',
      description:
        'Facturas, clientes, productos, gastos, asistencia y pagos. Fuente de verdad de negocio.',
      files: ['src/lib/facbal/client.ts'],
      env: ['FACBAL_API_URL', 'FACBAL_API_KEY'],
    },
    {
      id: 'galv2',
      label: 'galv2-tauri (desktop)',
      group: 'external',
      status: 'active',
      description:
        'App de escritorio que comparte backend_gal. No se conecta directamente a wacrm.',
    },
    {
      id: 'print_agent',
      label: 'Print Agent',
      group: 'external',
      status: 'active',
      description:
        'Polling de trabajos de impresión dentro de galv2-tauri. Independiente de wacrm.',
    },
  ],

  edges: [
    { id: 'e_wa_webhook', source: 'whatsapp', target: 'webhook' },
    { id: 'e_webhook_whitelist', source: 'webhook', target: 'whitelist', label: 'gate' },
    { id: 'e_webhook_flows', source: 'webhook', target: 'flows', label: 'prioridad #1' },
    { id: 'e_flows_automations', source: 'flows', target: 'automations', label: 'si no consume' },

    { id: 'e_whitelist_flows', source: 'whitelist', target: 'flows', label: 'no autorizado' },
    { id: 'e_whitelist_pending', source: 'whitelist', target: 'pending_confirm' },
    { id: 'e_whitelist_media', source: 'whitelist', target: 'media', label: 'imagen/doc' },
    { id: 'e_whitelist_audio', source: 'whitelist', target: 'audio', label: 'audio' },
    { id: 'e_whitelist_ctxcmd', source: 'whitelist', target: 'context_cmd', label: 'cancelar' },
    { id: 'e_whitelist_engine', source: 'whitelist', target: 'engine', label: 'texto' },

    { id: 'e_pending_expense', source: 'pending_confirm', target: 'h_expense' },
    { id: 'e_pending_attendance', source: 'pending_confirm', target: 'h_attendance' },
    { id: 'e_pending_voucher', source: 'pending_confirm', target: 'h_voucher' },
    { id: 'e_pending_pedido', source: 'pending_confirm', target: 'h_pedido' },
    { id: 'e_media_voucher', source: 'media', target: 'h_voucher' },
    { id: 'e_audio_engine', source: 'audio', target: 'engine', label: 'transcripción' },
    { id: 'e_ctxcmd_engine', source: 'context_cmd', target: 'engine', label: 'limpia y sigue' },

    { id: 'e_engine_extract', source: 'engine', target: 'extract', label: 'planTurn' },
    { id: 'e_extract_jev', source: 'extract', target: 'jev', label: 'en paralelo' },
    { id: 'e_jev_router', source: 'jev', target: 'router', label: 'override (si on)' },
    { id: 'e_extract_router', source: 'extract', target: 'router', label: 'intent/confianza' },
    { id: 'e_extract_planner', source: 'extract', target: 'planner', label: 'propuesta' },
    { id: 'e_planner_router', source: 'planner', target: 'router', label: 'reconcilePlans' },

    { id: 'e_router_expense', source: 'router', target: 'h_expense', label: 'expense' },
    { id: 'e_router_attendance', source: 'router', target: 'h_attendance', label: 'attendance' },
    { id: 'e_router_voucher', source: 'router', target: 'h_voucher', label: 'voucher' },
    { id: 'e_router_pedido', source: 'router', target: 'h_pedido', label: 'pedido' },
    { id: 'e_router_assistant', source: 'router', target: 'h_assistant', label: 'assistant' },
    { id: 'e_router_none', source: 'router', target: 'h_none', label: 'none' },

    { id: 'e_assistant_agent', source: 'h_assistant', target: 'agent' },
    { id: 'e_agent_tools', source: 'agent', target: 'tools' },
    { id: 'e_agent_kb', source: 'agent', target: 'kb' },
    { id: 'e_tools_backend', source: 'tools', target: 'backend_gal' },
    { id: 'e_tools_supabase', source: 'tools', target: 'supabase' },
    { id: 'e_kb_supabase', source: 'kb', target: 'supabase' },

    { id: 'e_expense_backend', source: 'h_expense', target: 'backend_gal' },
    { id: 'e_attendance_backend', source: 'h_attendance', target: 'backend_gal' },
    { id: 'e_voucher_backend', source: 'h_voucher', target: 'backend_gal' },
    { id: 'e_pedido_backend', source: 'h_pedido', target: 'backend_gal' },

    { id: 'e_assistant_autoreply', source: 'h_assistant', target: 'ai_autoreply', label: 'fallback' },
    { id: 'e_none_autoreply', source: 'h_none', target: 'ai_autoreply', label: 'fallback' },
    { id: 'e_webhook_automations', source: 'webhook', target: 'automations' },

    { id: 'e_extract_openrouter', source: 'extract', target: 'openrouter', label: 'LLM' },
    { id: 'e_jev_openrouter', source: 'jev', target: 'openrouter', label: 'Decisions API' },
    { id: 'e_agent_openrouter', source: 'agent', target: 'openrouter', label: 'LLM' },
    { id: 'e_voucher_openrouter', source: 'h_voucher', target: 'openrouter', label: 'visión' },

    { id: 'e_backend_supabase', source: 'backend_gal', target: 'supabase', label: 'misma DB' },
    { id: 'e_galv2_backend', source: 'galv2', target: 'backend_gal' },
    { id: 'e_print_backend', source: 'print_agent', target: 'backend_gal', label: 'polling' },

    { id: 'e_chatbot_openrouter', source: 'chatbot_legacy', target: 'openrouter', label: 'legado' },
    { id: 'e_chatbot_backend', source: 'chatbot_legacy', target: 'backend_gal', label: 'legado' },
    { id: 'e_voice_pedido', source: 'voice_orders', target: 'h_pedido', label: 'reemplazado' },
  ],
}

export function ecosystemNodeIds(): Set<string> {
  return new Set(ECOSYSTEM.nodes.map((n) => n.id))
}

/** True si todas las aristas apuntan a nodos existentes (test de sanidad). */
export function ecosystemIsConsistent(): boolean {
  return ECOSYSTEM.edges.every(
    (e) => ecosystemNodeIds().has(e.source) && ecosystemNodeIds().has(e.target),
  )
}

/** Conteo de nodos por estado, para la leyenda. */
export function statusCounts(): Record<EcosystemStatus, number> {
  const counts: Record<EcosystemStatus, number> = {
    active: 0,
    beta: 0,
    off: 0,
    retired: 0,
  }
  for (const n of ECOSYSTEM.nodes) counts[n.status] += 1
  return counts
}
