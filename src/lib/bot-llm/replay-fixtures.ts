/**
 * Carga de fixtures de replay (export de Supabase) para los tests.
 * Node-only: usa `fs`. No se importa desde código de app.
 *
 * El export de Supabase SQL Editor viene envuelto (`[{ "json": [ ... ] }]`)
 * cuando se usa `json_agg`; también soportamos `{ "json": [ ... ] }` y el
 * array plano.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RouterLogRow } from './replay'
import type { UnifiedExtraction } from './types'

const FIXTURES_DIR = join(process.cwd(), 'test', 'fixtures')

/** Desenvuelve las 3 formas posibles del export (array plano o `{json: [...]}`). */
export function unwrapLogExport(raw: unknown): unknown[] {
  if (Array.isArray(raw)) {
    if (
      raw.length === 1 &&
      raw[0] &&
      typeof raw[0] === 'object' &&
      Array.isArray((raw[0] as { json?: unknown }).json)
    ) {
      return (raw[0] as { json: unknown[] }).json
    }
    return raw
  }
  if (raw && typeof raw === 'object' && Array.isArray((raw as { json?: unknown }).json)) {
    return (raw as { json: unknown[] }).json
  }
  return []
}

function readJson(fileName: string): unknown {
  const path = join(FIXTURES_DIR, fileName)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // Fixture ausente (p. ej. en CI, porque contiene PII y está gitignoreado):
    // se devuelve vacío y los tests que lo consumen se saltean.
    return []
  }
}

export function loadRouterLogs(): RouterLogRow[] {
  return unwrapLogExport(readJson('router-logs.json')) as RouterLogRow[]
}

export interface VoucherExtractionRow {
  message_id: string
  match_status: string
  extracted_amount: number | null
  extracted_date: string | null
  extracted_reference: string | null
  extracted_bank: string | null
  debug_info: Record<string, unknown> | null
  created_at?: string
}

export function loadVoucherExtractions(): VoucherExtractionRow[] {
  return unwrapLogExport(readJson('voucher-extractions.json')) as VoucherExtractionRow[]
}

/** Extracción guardada en `debug_info.extraction` (puede faltar). */
export function storedExtraction(row: RouterLogRow): UnifiedExtraction | null {
  return (row.extraction as UnifiedExtraction | null) ?? null
}
