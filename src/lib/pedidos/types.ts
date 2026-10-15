// Tipos del flujo de presupuestos por bot (pedidos).

/** Ítem parseado por el LLM/regex: cantidad + texto crudo del usuario. */
export interface ParsedOrderItem {
  cantidad: number
  /** Conserva el vocabulario del usuario ("sin tela", "pintura", "60x40"...). */
  texto: string
}

/** Tipo de entrega (mismos valores que galv2 / backend_gal). */
export type TipoEntrega = 'Retira' | 'Envio' | 'Retiro y Envio'

/** Descuento tal como lo devuelve el parseo (sin monto calculado todavía). */
export interface ParsedDescuento {
  mode: 'amount' | 'percent'
  value: number
}

/** Descuento ya resuelto: `amount` es el monto final a restar. */
export interface DescuentoState extends ParsedDescuento {
  amount: number
}

/** Cliente candidato del catálogo (para confirmar antes de vincular). */
export interface ClienteCandidato {
  id: number
  nombre: string
  telefono: string | null
  score: number
}

/** Resultado del parseo de un pedido (antes de resolver precios). */
export interface ParsedOrder {
  cliente: string | null
  items: ParsedOrderItem[]
  /** Datos de entrega/descuento si el usuario los mencionó en el mensaje. */
  tipoEntrega?: TipoEntrega | null
  fechaEntrega?: string | null
  descuento?: ParsedDescuento | null
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
  /** Teléfono del cliente elegido, nunca el teléfono interno del remitente. */
  clienteTelefono?: string | null
  /**
   * Cliente vinculado. `undefined` = todavía no se resolvió (hay que buscar
   * candidatos); `null` = confirmado como cliente nuevo (se crea al ejecutar).
   */
  clienteId?: number | null
  /** Domicilio de entrega elegido (texto libre; puede no estar en el padrón). */
  clienteDomicilio?: string | null
  /** Candidatos del catálogo cuando el nombre es ambiguo (para elegir). */
  clienteCandidatos?: ClienteCandidato[]
  tipoEntrega?: TipoEntrega
  /** JSON `{"desde","hasta","extras"}` (D/M/AAAA) o '' si no hay fecha. */
  fechaEntrega?: string
  /**
   * `undefined` = todavía no se preguntó; `null` = sin descuento; objeto = hay
   * descuento.
   */
  descuento?: DescuentoState | null
  total: number
  faltantes: string[]
  notaSupuestos: string[]
  /** True cuando el usuario confirmó pero falta el nombre del cliente. */
  awaitingCliente?: boolean
  /** Estamos mostrando una cotización, aún no se inició la creación/guardado. */
  awaitingQuoteApproval?: boolean
  /**
   * El usuario descartó la cotización pero se conserva para retomarla (soft-cancel).
   * Mientras esté dentro del TTL de recall, un "hacelo" la reanuda.
   */
  quoteCancelled?: boolean
  /** Texto original usado para reconstruir el presupuesto si el usuario acepta. */
  quoteText?: string | null
  /** El dueño pidió crear un presupuesto pero todavía no indicó los ítems. */
  awaitingOrderItems?: boolean
  /** True cuando mostramos candidatos de cliente y esperamos la elección. */
  awaitingClienteChoice?: boolean
  /** True cuando esperamos el tipo de entrega (Retira/Envío/Ret+Env). */
  awaitingEntrega?: boolean
  /** True cuando esperamos la fecha de entrega. */
  awaitingFecha?: boolean
  /** True cuando esperamos el descuento (monto, % o "no"). */
  awaitingDescuento?: boolean
  /**
   * True cuando se preguntó todo junto (entrega+fecha+domicilio+descuento,
   * Caso 3): la respuesta se parsea de una vez con `interpretDeliveryReply`.
   */
  awaitingDatos?: boolean
  /** True cuando esperamos solo el domicilio (envío sin dirección). */
  awaitingDomicilio?: boolean
  /**
   * True mientras esperamos que el usuario explique un término desconocido
   * (glosario). Guarda los términos y el texto original del pedido para
   * re-resolver cuando responda.
   */
  awaitingGlossary?: { terms: string[]; orderText: string } | null
  /**
   * Faltó un atributo de un ítem (medida/variante) y esperamos que el usuario lo
   * indique. Guarda el pedido parseado para completar el ítem y re-resolver sin
   * volver a llamar al parser.
   */
  awaitingItemAttr?: {
    itemIndex: number
    ask: 'medida' | 'variante'
    options: string[]
    term: string
    parsed: ParsedOrder
    orderText: string
  } | null
  updatedAt?: number | null
}
