/**
 * Whitelist de números autorizados del bot.
 *
 * Solo los números cargados en `bot_allowed_numbers` (por cuenta) pueden
 * disparar el bot determinístico (gastos / asistencia / voucher / asistente).
 * Los no autorizados (clientes) siguen por Flows / AI auto-reply y NO reciben
 * respuesta del bot.
 *
 * Política de fallo: si la tabla no existe o la consulta falla, se hace
 * fail-open (se permite) para no apagar el bot por un error de infra, con un
 * log ruidoso para diagnostico. Si la tabla existe y el número no está
 * (o está inactivo), se deniega.
 *
 * Kill switch: `BOT_WHITELIST_ENFORCED=false` desactiva el gate (deja pasar a
 * todos), mismo efecto que no tener whitelist.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'

export function isWhitelistEnforced(): boolean {
  return process.env.BOT_WHITELIST_ENFORCED !== 'false'
}

/** Normaliza un teléfono de whitelist (solo dígitos). Null si es inválido/corto. */
export function normalizeAllowedPhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const p = normalizePhone(raw)
  return p.length >= 7 ? p : null
}

/** Normaliza y deduplica una lista de teléfonos (para alta individual o bulk). */
export function normalizeAllowedPhones(raw: unknown[]): string[] {
  return [...new Set(raw.map(normalizeAllowedPhone).filter((p): p is string => !!p))]
}

export async function isPhoneAllowed(
  db: SupabaseClient,
  accountId: string,
  phone: string,
): Promise<boolean> {
  if (!isWhitelistEnforced()) return true

  const normalized = normalizePhone(phone)
  if (!normalized) return false

  try {
    const { data, error } = await db
      .from('bot_allowed_numbers')
      .select('id')
      .eq('account_id', accountId)
      .eq('phone', normalized)
      .eq('active', true)
      .limit(1)
      .maybeSingle()

    if (error) {
      const msg = error.message ?? String(error)
      if (msg.includes('relation') && msg.includes('does not exist')) {
        console.error(
          '[whitelist] TABLE MISSING — run migration 050_bot_allowed_numbers.sql in Supabase. FAIL-OPEN: bot habilitado para todos.',
        )
      } else {
        console.error('[whitelist] lookup failed, FAIL-OPEN:', msg)
      }
      // Fail-open: un error de infra no debe silenciar números válidos.
      return true
    }

    return data !== null
  } catch (err) {
    console.error(
      '[whitelist] lookup threw, FAIL-OPEN:',
      err instanceof Error ? err.message : String(err),
    )
    return true
  }
}
