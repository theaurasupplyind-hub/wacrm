export type BotIntent =
  | 'asistencia_llegada'
  | 'asistencia_salida'
  | 'asistencia_estado'
  | 'gasto'
  | 'voucher'
  | 'pedido'
  | 'factura'
  | 'otro'

export type Confidence = 'alta' | 'media' | 'baja'

export type MissingField =
  | 'empleado'
  | 'hora'
  | 'estado'
  | 'monto'
  | 'categoria'
  | 'proveedor'

export interface UnifiedExtraction {
  intent: BotIntent
  confianza: Confidence
  /**
   * Cómo se obtuvo esta extracción: 'llm' cuando el extractor respondió JSON
   * válido, 'fallback' cuando se cayó a la red regex (fallbackExtract).
   */
  extractor_source: 'llm' | 'fallback'
  // asistencia
  empleado: string | null
  hora: string | null
  estado: 'vacaciones' | 'licencia' | 'ausente' | null
  // gasto
  monto: number | null
  categoria: string | null
  proveedor: string | null
  empleado_gasto: string | null
  metodo_pago: string | null
  // común
  fecha: string | null
  faltan_campos: MissingField[]
  dudoso: boolean
  razon_duda: string | null
  raw: string
}
