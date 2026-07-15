export interface VoiceOrderItem {
  categoria: string
  medida: string
  variante: string
  cantidad: number
}

export interface ParsedOrder {
  tipo: 'presupuesto'
  cliente_nombre: string
  items: VoiceOrderItem[]
}

export interface PricedItem {
  cantidad: number
  categoria: string
  variante: string
  medida_solicitada: string
  medida_referencia: string
  precio: number | null
  faltante: boolean
}

export interface VoiceOrderLog {
  step: string
  data: Record<string, unknown>
}

export interface VoiceOrderResult {
  transcription: string
  parsedOrder: ParsedOrder | null
  client: { id: number | null; nombre: string } | null
  pricing: {
    items: PricedItem[]
    total: number
  } | null
  invoice: { numero: string; id: number } | null
  error: string | null
  logs: VoiceOrderLog[]
}

export interface VoiceOrderArgs {
  buffer: Buffer
  mimeType: string
  senderPhone: string
  senderName: string
  commit: boolean
}
