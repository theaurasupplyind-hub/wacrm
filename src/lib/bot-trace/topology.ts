/**
 * Topología estática del flujo del bot.
 *
 * Es un dato puro (serializable) que describe los nodos y aristas del
 * flujo real de `processMessage` (webhook → contextos → handlers → cerebro
 * → router → dispatch → terminales). El diagrama visual lo renderiza con
 * React Flow + dagre, y cada `BotTrace` referencia estos `id` en su `path`.
 *
 * Al tocar el flujo real, actualizar acá: los ids son el contrato entre la
 * instrumentación y el dibujo.
 */

export type TopologyNodeKind =
  | 'entry'
  | 'context'
  | 'handler'
  | 'brain'
  | 'dispatch'
  | 'terminal'

export interface TopologyNode {
  id: string
  label: string
  kind: TopologyNodeKind
  description?: string
}

export interface TopologyEdge {
  id: string
  source: string
  target: string
  label?: string
}

export const BOT_TOPOLOGY: { nodes: TopologyNode[]; edges: TopologyEdge[] } = {
  nodes: [
    {
      id: 'webhook',
      label: 'Mensaje entrante',
      kind: 'entry',
      description: 'POST /api/whatsapp/webhook → processMessage',
    },

    // Contextos multi-turn que se cargan antes de decidir.
    { id: 'ctx_expense', label: 'Contexto gasto', kind: 'context' },
    { id: 'ctx_attendance', label: 'Contexto asistencia', kind: 'context' },
    { id: 'ctx_voucher', label: 'Contexto voucher', kind: 'context' },
    { id: 'ctx_clarify', label: 'Contexto aclaración', kind: 'context' },

    // Handlers por tipo de media / evento.
    {
      id: 'h_voucher_media',
      label: 'Voucher (imagen/doc)',
      kind: 'handler',
      description: 'voucher-pipeline: extracción + fases 1-5',
    },
    { id: 'h_expense', label: 'Gastos', kind: 'handler' },
    { id: 'h_attendance', label: 'Asistencia', kind: 'handler' },
    { id: 'h_flow', label: 'Flows / Automations', kind: 'handler' },
    { id: 'h_clarify', label: 'Aclaración', kind: 'handler' },
    {
      id: 'h_assistant',
      label: 'Asistente',
      kind: 'handler',
      description: 'runAssistant (tools, KB, deuda)',
    },

    // Cerebro: extracción LLM + Jev y ruteo puro.
    {
      id: 'extract',
      label: 'Extracción LLM + Jev',
      kind: 'brain',
      description: 'extractBotMessage / classifyWithJev',
    },
    {
      id: 'router',
      label: 'Router (decideDispatch)',
      kind: 'brain',
      description: 'Función pura: estado → dispatched_to',
    },

    // Dispatch: rama elegida.
    { id: 'd_expense', label: '→ Gastos', kind: 'dispatch' },
    { id: 'd_attendance', label: '→ Asistencia', kind: 'dispatch' },
    { id: 'd_voucher', label: '→ Voucher', kind: 'dispatch' },
    { id: 'd_assistant', label: '→ Asistente', kind: 'dispatch' },
    { id: 'd_none', label: '→ Nada', kind: 'dispatch' },

    // Terminales.
    { id: 't_matched', label: 'Matcheado', kind: 'terminal' },
    { id: 't_ambiguous', label: 'Ambiguo (pregunta)', kind: 'terminal' },
    { id: 't_multi_invoice', label: 'Multi-factura', kind: 'terminal' },
    { id: 't_no_match', label: 'Sin match', kind: 'terminal' },
    { id: 't_no_reply', label: 'Sin respuesta', kind: 'terminal' },
    { id: 't_error', label: 'Error', kind: 'terminal' },
    { id: 't_clarify_ask', label: 'Pregunta aclaración', kind: 'terminal' },
    { id: 't_replied', label: 'Respondido', kind: 'terminal' },
  ],
  edges: [
    { id: 'e_entry_ctxe', source: 'webhook', target: 'ctx_expense' },
    { id: 'e_entry_ctxa', source: 'webhook', target: 'ctx_attendance' },
    { id: 'e_entry_ctxv', source: 'webhook', target: 'ctx_voucher' },
    { id: 'e_entry_ctxc', source: 'webhook', target: 'ctx_clarify' },

    { id: 'e_entry_hvoc', source: 'webhook', target: 'h_voucher_media', label: 'imagen/documento' },
    { id: 'e_entry_hexp', source: 'webhook', target: 'h_expense', label: 'caption gasto' },
    { id: 'e_entry_flow', source: 'webhook', target: 'h_flow', label: 'flow runner' },
    { id: 'e_entry_extract', source: 'webhook', target: 'extract', label: 'texto' },

    { id: 'e_ctxe_extract', source: 'ctx_expense', target: 'extract' },
    { id: 'e_ctxa_extract', source: 'ctx_attendance', target: 'extract' },
    { id: 'e_ctxv_extract', source: 'ctx_voucher', target: 'extract' },
    { id: 'e_ctxc_extract', source: 'ctx_clarify', target: 'extract' },

    { id: 'e_extract_router', source: 'extract', target: 'router', label: 'intent/confianza' },
    { id: 'e_extract_clarify', source: 'extract', target: 'h_clarify', label: 'ambiguo' },
    { id: 'e_ctxc_router', source: 'ctx_clarify', target: 'router', label: 'respuesta resuelve intent' },

    { id: 'e_router_dexp', source: 'router', target: 'd_expense', label: 'expense' },
    { id: 'e_router_datt', source: 'router', target: 'd_attendance', label: 'attendance' },
    { id: 'e_router_dvoc', source: 'router', target: 'd_voucher', label: 'voucher' },
    { id: 'e_router_dass', source: 'router', target: 'd_assistant', label: 'assistant' },
    { id: 'e_router_dnon', source: 'router', target: 'd_none', label: 'none' },

    { id: 'e_dexp_hexp', source: 'd_expense', target: 'h_expense' },
    { id: 'e_datt_hatt', source: 'd_attendance', target: 'h_attendance' },
    { id: 'e_dvoc_hvoc', source: 'd_voucher', target: 'h_voucher_media' },
    { id: 'e_dass_hass', source: 'd_assistant', target: 'h_assistant' },

    { id: 'e_hvoc_tmatch', source: 'h_voucher_media', target: 't_matched' },
    { id: 'e_hvoc_tamb', source: 'h_voucher_media', target: 't_ambiguous' },
    { id: 'e_hvoc_tmulti', source: 'h_voucher_media', target: 't_multi_invoice' },
    { id: 'e_hvoc_tnomatch', source: 'h_voucher_media', target: 't_no_match' },
    { id: 'e_hclarify_task', source: 'h_clarify', target: 't_clarify_ask' },
    { id: 'e_hexp_treply', source: 'h_expense', target: 't_replied' },
    { id: 'e_hexp_tnoreply', source: 'h_expense', target: 't_no_reply' },
    { id: 'e_hexp_terror', source: 'h_expense', target: 't_error' },
    { id: 'e_hatt_treply', source: 'h_attendance', target: 't_replied' },
    { id: 'e_hass_treply', source: 'h_assistant', target: 't_replied' },
    { id: 'e_flow_treply', source: 'h_flow', target: 't_replied' },
    { id: 'e_dnon_tnomatch', source: 'd_none', target: 't_no_match' },
  ],
}

export function topologyNodeIds(): Set<string> {
  return new Set(BOT_TOPOLOGY.nodes.map((n) => n.id))
}

/** True si todas las aristas apuntan a nodos existentes (test de sanidad). */
export function topologyIsConsistent(): boolean {
  const ids = topologyNodeIds()
  return BOT_TOPOLOGY.edges.every((e) => ids.has(e.source) && ids.has(e.target))
}

/** Mapea `dispatched_to` del router al nodo de dispatch correspondiente. */
export function dispatchNodeId(dispatchedTo: string | null | undefined): string | null {
  switch (dispatchedTo) {
    case 'expense':
      return 'd_expense'
    case 'attendance':
      return 'd_attendance'
    case 'voucher':
      return 'd_voucher'
    case 'assistant':
      return 'd_assistant'
    case 'flow':
    case 'interactive':
    case 'clarify':
    case 'none':
      return 'd_none'
    default:
      return null
  }
}
