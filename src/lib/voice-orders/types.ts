export interface VoiceOrderItem {
  descripcion: string
  cantidad: number
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
}

export interface ParsedOrder {
  tipo: 'presupuesto' | 'respuesta_variante'
  cliente_nombre: string | null
  items: VoiceOrderItem[]
  variante_respuesta?: string
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

export interface VoiceOrderLog {
  step: string
  data: Record<string, unknown>
}

export interface VoiceOrderResult {
  transcription: string
  parsedOrder: ParsedOrder | null
  resolvedItems: ResolvedItem[] | null
  client: { id: number | null; nombre: string } | null
  pricing: {
    items: PricedItem[]
    total: number
  } | null
  invoice: { numero: string; id: number } | null
  error: string | null
  logs: VoiceOrderLog[]
  pendingVariantItems?: ResolvedItem[]
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
}
