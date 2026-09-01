export interface VoiceOrderItem {
  descripcion: string
  cantidad: number
}

export interface ParsedOrderItem {
  categoria: string | null
  medida: string | null
  variante: string | null
  cantidad: number
  descripcion_original: string
}

export interface ResolvedItem {
  descripcion: string
  cantidad: number
  categoria: string
  medida: string
  variante: string
  precio_base: number | null
  medida_referencia: string | null
  faltante: boolean
  necesita_variante?: boolean
  variantes_disponibles?: string[]
  necesita_precio?: boolean
}

export type ParsedOrderType = 'presupuesto' | 'respuesta_variante' | 'respuesta_confirmacion' | 'respuesta_cancelacion'
export type Confidence = 'alta' | 'baja'

export interface ParsedOrder {
  tipo: ParsedOrderType
  confianza: Confidence
  cliente_nombre: string | null
  items: VoiceOrderItem[]
  entidades: ParsedOrderItem[]
  variante_respuesta: string | null
  faltan_campos: string[]
  dudoso: boolean
  razon_duda: string | null
}

export interface IntentClassification {
  tipo: 'pedido' | 'gasto' | 'voucher' | 'asistencia' | 'factura' | 'otro'
  confianza: Confidence
}

export interface PricedItem {
  cantidad: number
  categoria: string
  variante: string
  medida_solicitada: string
  medida_referencia: string
  precio: number | null
  faltante: boolean
  precio_base: number | null
  regla_aplicada: string | null
}

export interface PendingInvoice {
  resolvedItems: ResolvedItem[]
  client: { id: number | null; nombre: string; telefono?: string; domicilio?: string }
  pricing: { items: PricedItem[]; total: number }
}

export type ClientInfo = { id: number | null; nombre: string; telefono?: string; domicilio?: string }

export interface VoiceOrderLog {
  step: string
  data: Record<string, unknown>
}

export interface VoiceOrderResult {
  transcription: string
  parsedOrder: ParsedOrder | null
  resolvedItems: ResolvedItem[] | null
  client: ClientInfo | null
  pricing: {
    items: PricedItem[]
    total: number
  } | null
  invoice: { numero: string; id: number } | null
  error: string | null
  logs: VoiceOrderLog[]
  pendingVariantItems?: ResolvedItem[]
  pendingClientName?: string | null
  pendingInvoice?: PendingInvoice | null
}

export interface VoiceOrderArgs {
  buffer: Buffer
  mimeType: string
  senderPhone: string
  senderName: string
  commit: boolean
}

export interface TextOrderArgs {
  text: string
  senderPhone: string
  senderName: string
  commit: boolean
  pendingVariantItems?: ResolvedItem[]
  pendingClientName?: string | null
  pendingInvoice?: PendingInvoice | null
  historyText?: string
}
