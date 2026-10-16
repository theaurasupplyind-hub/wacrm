/**
 * Parsea la respuesta a la pregunta combinada de datos de entrega (Caso 3).
 *
 * El usuario responde TODO en un mensaje ("envío, viernes, al taller de
 * marcos, 10%") y el LLM lo descompone en campos. Ante cualquier fallo se
 * devuelve todo null y el flujo pregunta por separado (advance).
 * Sin side effects: solo interpreta.
 */
import { callOpenRouter } from '@/lib/ai/openrouter'
import type { TipoEntrega } from './types'

export interface KnownAddress {
  address: string
  is_default: boolean
}

export interface DeliveryInfo {
  /** Nombre del cliente si lo dijo junto con los datos ("a nombre de Fede"). */
  cliente?: string | null
  tipoEntrega?: TipoEntrega | null
  /** Texto crudo de fecha ("el viernes", "15/11", "no") o null si no dijo. */
  fechaRaw?: string | null
  /** Descuento: objeto, "no", o null si no dijo. */
  descuento?: { mode: 'amount' | 'percent'; value: number } | 'no' | null
  /**
   * Domicilio: texto EXACTO de una dirección conocida, texto libre nuevo,
   * o null si no dijo.
   */
  domicilio?: string | null
}

const DELIVERY_PROMPT = `Sos el parser de datos de entrega de un presupuesto en un taller. Devolvé EXCLUSIVAMENTE un JSON: {"cliente": string | null, "tipo_entrega": "Retira" | "Envio" | "Retiro y Envio" | null, "fecha": string | null, "descuento": {"mode": "amount" | "percent", "value": number} | "no" | null, "domicilio": string | null}.
- "cliente": el nombre del cliente si lo dice ("a nombre de Fede", "para Juan", "el cliente es X") o si el mensaje es SÓLO un nombre (ej. "Fede"). Si no, null. Nunca tomes un saludo como nombre.
- "tipo_entrega": lo que pida (retira/envío/retiro y envío y variantes). null si no dice.
- "fecha": el texto tal cual ("el viernes", "15/11"); "no" si dice que no; null si no dice.
- "descuento": objeto si da monto o %; "no" si dice que no; null si no dice.
- "domicilio": si nombra una dirección de la lista, devolvé el texto EXACTO de la lista; si da una dirección nueva, devolvé su texto; null si no dice.
DEVOLVÉ SOLO EL JSON.`

const VALID_ENTREGA = new Set(['Retira', 'Envio', 'Retiro y Envio'])

export async function interpretDeliveryReply(
  text: string,
  known: KnownAddress[] = [],
): Promise<DeliveryInfo> {
  const empty: DeliveryInfo = {}
  if (!text || !text.trim()) return empty
  try {
    const addrLine =
      known.length > 0
        ? `\nDirecciones conocidas del cliente: ${known.map((a) => `"${a.address}"${a.is_default ? ' (predeterminada)' : ''}`).join(' | ')}`
        : '\nSin direcciones conocidas.'
    const res = await callOpenRouter({
      systemPrompt: DELIVERY_PROMPT,
      userMessage: `${addrLine}\nMensaje del usuario: "${text}"`,
      jsonMode: true,
      temperature: 0,
      maxTokens: 300,
      model: process.env.EXTRACTOR_MODEL || undefined,
    })
    const block = res.text.match(/\{[\s\S]*\}/)
    const parsed = JSON.parse(block ? block[0] : res.text) as Record<string, unknown>
    const out: DeliveryInfo = {}
    if (typeof parsed.cliente === 'string' && parsed.cliente.trim()) {
      out.cliente = parsed.cliente.trim()
    }
    if (typeof parsed.tipo_entrega === 'string' && VALID_ENTREGA.has(parsed.tipo_entrega)) {
      out.tipoEntrega = parsed.tipo_entrega as TipoEntrega
    }
    if (typeof parsed.fecha === 'string' && parsed.fecha.trim()) {
      out.fechaRaw = parsed.fecha.trim()
    }
    const d = parsed.descuento as unknown
    if (d === 'no') {
      out.descuento = 'no'
    } else if (d && typeof d === 'object') {
      const o = d as { mode?: unknown; value?: unknown }
      const value = typeof o.value === 'number' ? o.value : Number(o.value)
      if ((o.mode === 'amount' || o.mode === 'percent') && Number.isFinite(value) && value > 0) {
        out.descuento = { mode: o.mode, value }
      }
    }
    if (typeof parsed.domicilio === 'string' && parsed.domicilio.trim()) {
      out.domicilio = parsed.domicilio.trim()
    }
    return out
  } catch (err) {
    console.error('[interpret-delivery] LLM falló, se pregunta por separado:', err instanceof Error ? err.message : String(err))
    return empty
  }
}
