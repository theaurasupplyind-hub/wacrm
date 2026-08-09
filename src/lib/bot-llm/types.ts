export type BotIntent =
  | 'asistencia_llegada'
  | 'asistencia_salida'
  | 'asistencia_estado'
  | 'gasto'
  | 'multi_expense'
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

/**
 * Un gasto individual dentro de un mensaje multi-expense. `amount` o
 * `category` pueden ser null si el LLM no logró extraerlos; el flujo de
 * confirmación preguntará por el campo faltante antes de guardar.
 */
export interface MultiExpenseItem {
  amount: number | null
  category: string | null
  provider: string | null
  employee: string | null
  payment_method: string | null
  description: string | null
  date: string | null
  raw: string
}

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
  // multi-expense (solo si intent es 'multi_expense')
  multipleExpenses?: MultiExpenseItem[]
  // común
  fecha: string | null
  faltan_campos: MissingField[]
  dudoso: boolean
  razon_duda: string | null
  raw: string
  // ── Debug (persistido en router_logs.debug_info.extraction) ──
  /**
   * Texto crudo devuelto por el LLM antes de extraer/sanitizar el JSON.
   * Solo presente cuando extractor_source === 'llm' o cuando el fallback
   * fue causado por un problema del LLM (no se setea si nunca se llamó).
   */
  llm_raw?: string | null
  /** JSON parseado tal como lo devolvió el LLM, ANTES de sanitizeParsed. */
  llm_raw_json?: Record<string, unknown> | null
  /** Motivo por el cual se cayó al fallback regex (o null si el LLM respondió OK). */
  fallback_reason?: 'llm_call_failed' | 'no_json' | 'invalid_json' | 'schema_out_of_range' | null
  /** Mensaje de error/detalle asociado al fallback (si aplica). */
  llm_error?: string | null
  /** Tokens usados en la llamada al LLM (si se llegó a llamar). */
  llm_usage?: { prompt_tokens: number; completion_tokens: number } | null
}
