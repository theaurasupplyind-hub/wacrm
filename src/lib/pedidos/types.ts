// Tipos del flujo de presupuestos por bot (pedidos).

/** Ítem parseado por el LLM/regex: cantidad + texto crudo del usuario. */
export interface ParsedOrderItem {
  cantidad: number
  /** Conserva el vocabulario del usuario ("sin tela", "pintura", "60x40"...). */
  texto: string
}

/** Resultado del parseo de un pedido (antes de resolver precios). */
export interface ParsedOrder {
  cliente: string | null
  items: ParsedOrderItem[]
}

/** Ítem ya resuelto con precio (o marcado como faltante). */
export interface PedidoItem {
  cantidad: number
  categoria: string
  medida: string | null
  variante: string | null
  precio_unitario: number | null
  faltante: boolean
  descripcion: string
  regla_aplicada: string | null
  /** Supuesto asumido al resolver (variante / perímetro / precio provisional). */
  asumido?: string | null
  /** True cuando el precio es provisional y hay que revisarlo a mano. */
  aRevisar?: boolean
}

/** Estado del pedido guardado en `conversations.order_context`. */
export interface OrderContext {
  stage: 'confirming'
  items: PedidoItem[]
  clienteNombre: string | null
  total: number
  faltantes: string[]
  notaSupuestos: string[]
  /** True cuando el usuario confirmó pero falta el nombre del cliente. */
  awaitingCliente?: boolean
  /**
   * True mientras esperamos que el usuario explique un término desconocido
   * (glosario). Guarda los términos y el texto original del pedido para
   * re-resolver cuando responda.
   */
  awaitingGlossary?: { terms: string[]; orderText: string } | null
  updatedAt?: number | null
}
