export type BotIntent =
  | 'asistencia_llegada'
  | 'asistencia_salida'
  | 'asistencia_estado'
  | 'gasto'
  | 'multi_expense'
  | 'voucher'
  | 'factura'
  | 'otro'

export type Confidence = 'alta' | 'media' | 'baja'

/**
 * Persona gramatical del verbo de pago/voucher. `first` = "pagué/transferí"
 * (yo pago); `third` = "X pagó/paga" (un tercero paga). Se usa para decidir
 * voucher (cobro) vs gasto (pago) por ROL y no por regex de capitalización.
 */
export type PaymentVoice = 'first' | 'third' | null

/** Dirección del dinero: `cobro` (un cliente nos paga) o `pago` (nosotros pagamos). */
export type PaymentDirection = 'cobro' | 'pago' | null

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
  tipo_gasto: 'compra' | 'pago' | 'gasto' | null
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
  tipo_gasto: 'compra' | 'pago' | 'gasto' | null
  saldo_pendiente: number | null
  proveedor: string | null
  empleado_gasto: string | null
  /** Destinatario que recibe en un voucher ("Jo pagó a Jorge" → Jorge). */
  destino: string | null
  metodo_pago: string | null
  // ── Roles tipados de pago (fuente para decidir voucher vs gasto) ──
  /** Quien paga/transfiere ("Jo pagó..." → Jo). */
  payer?: string | null
  /** Quien recibe ("...a Jorge" → Jorge). */
  payee?: string | null
  /** Persona gramatical del verbo ("pagué" → first; "Jo pagó" → third). */
  voice?: PaymentVoice
  /** Dirección del dinero (cobro/pago). */
  direction?: PaymentDirection
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
  // ── Debug / decisión Jev (System One, ver src/lib/ai/jev.ts) ──
  /** Intent propuesto por Jev (siempre presente si Jev respondió). */
  jev_intent?: BotIntent | null
  /** `confidence` calibrado de Jev para el intent (0–1). */
  jev_confidence?: number | null
  /** Distribución completa de probabilidades del intent. */
  jev_probabilities?: Record<string, number> | null
  /** Dominio de pendiente al que responde el mensaje. */
  jev_pending_domain?: 'expense' | 'attendance' | 'voucher' | 'none' | null
  /** Probabilidad de que el mensaje responda al pendiente (noul). */
  jev_answers_pending?: number | null
  /** Probabilidad de que sea una orden nueva que reemplaza el pendiente (noul). */
  jev_supersedes?: number | null
  /** true solo cuando el intent/confianza final provienen de Jev (no shadow). */
  jev_used?: boolean
  /** Motivo por el que Jev no aportó (call_failed, etc.). */
  jev_error?: string | null
  /** Tokens consumidos por la llamada a Jev. */
  jev_usage?: { input_tokens: number; output_tokens: number } | null
}
