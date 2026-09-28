import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/facbal/client', () => ({
  matchVoucherByName: vi.fn(),
}))

import { matchVoucherByName } from '@/lib/facbal/client'
import { runVoucherDryRun } from './voucher-dryrun'
import type { MatchVoucherCandidate } from '@/lib/facbal/client'

const mockMatch = matchVoucherByName as unknown as ReturnType<typeof vi.fn>

function cand(over: Partial<MatchVoucherCandidate>): MatchVoucherCandidate {
  return {
    invoice_id: 1,
    numero_factura: 'F-1',
    cliente_nombre: 'Test',
    cliente_telefono: '11',
    saldo_pendiente: 48000,
    total: 48000,
    fecha: '2026-01-01',
    score: 0.9,
    ...over,
  }
}

const TEST_INVOICE = cand({})
const JB_INVOICE = cand({ invoice_id: 2, numero_factura: 'F-10458', cliente_nombre: 'JB Lavallol', saldo_pendiente: 66000, total: 66000, score: 0.9 })

beforeEach(() => {
  mockMatch.mockReset()
  mockMatch.mockImplementation(async (args: { nombre_cliente: string | null; tolerancia: number }) => {
    // Búsqueda por nombre del cliente -> facturas de Test
    if (args.nombre_cliente) {
      return { invoice_candidates: [TEST_INVOICE], destination_candidates: [] }
    }
    // Búsqueda por monto con tolerancia amplia -> cliente ajeno
    if (args.tolerancia >= 10000) {
      return { invoice_candidates: [JB_INVOICE], destination_candidates: [] }
    }
    return { invoice_candidates: [], destination_candidates: [] }
  })
})

const base = {
  fecha: null,
  referencia: null,
  banco: null,
  nombre_destino: null,
  cbu_destino: null,
  cuit_destino: null,
}

describe('runVoucherDryRun · texto: el nombre manda', () => {
  it('nombre confiable con saldo distinto → ofrece parcial y no muestra ajenos', async () => {
    const r = await runVoucherDryRun({ ...base, monto: 45000, nombre_cliente: 'Test', nombre_origen: 'Test' })
    expect(r.matchStatus).toBe('ambiguous')
    expect(r.candidates.every((c) => c.cliente_nombre === 'Test')).toBe(true)
    expect(r.candidates.some((c) => c.cliente_nombre === 'JB Lavallol')).toBe(false)
    expect(r.mensajeRespuesta.toLowerCase()).toContain('parcial')
    expect(r.matchedNameScore).toBe(0.9)
  })

  it('nombre sin facturas → "No encontré facturas pendientes de X" (sin fallback a ajenos)', async () => {
    mockMatch.mockImplementation(async (args: { nombre_cliente: string | null; tolerancia: number }) => {
      if (args.nombre_cliente) return { invoice_candidates: [], destination_candidates: [] }
      if (args.tolerancia >= 10000) return { invoice_candidates: [JB_INVOICE], destination_candidates: [] }
      return { invoice_candidates: [], destination_candidates: [] }
    })
    const r = await runVoucherDryRun({ ...base, monto: 45000, nombre_cliente: 'Test', nombre_origen: 'Test' })
    expect(r.matchStatus).toBe('no_match')
    expect(r.mensajeRespuesta).toContain('No encontré facturas pendientes de Test')
    expect(r.candidates).toHaveLength(0)
  })

  it('nombre + saldo exacto → matched (con score)', async () => {
    const r = await runVoucherDryRun({ ...base, monto: 48000, nombre_cliente: 'Test', nombre_origen: 'Test' })
    expect(r.matchStatus).toBe('matched')
    expect(r.matchedClienteNombre).toBe('Test')
    expect(r.matchedInvoiceNumero).toBe('F-1')
    expect(r.matchedNameScore).toBe(0.9)
  })

  it('sin nombre en texto → pide el nombre (no inventa candidatos)', async () => {
    const r = await runVoucherDryRun({ ...base, monto: 45000, nombre_cliente: null, nombre_origen: null })
    expect(r.matchStatus).toBe('ambiguous')
    expect(r.mensajeRespuesta.toLowerCase()).toContain('decinos el nombre')
  })

  it('1 factura con monto exacto + nombre distinto → matched directo (no pregunta)', async () => {
    mockMatch.mockImplementation(async (args: { nombre_cliente: string | null; tolerancia: number }) => {
      if (args.nombre_cliente) return { invoice_candidates: [], destination_candidates: [] }
      if (args.tolerancia <= 50) return { invoice_candidates: [TEST_INVOICE], destination_candidates: [] }
      return { invoice_candidates: [], destination_candidates: [] }
    })
    const r = await runVoucherDryRun({ ...base, monto: 48000, nombre_cliente: 'Otro', nombre_origen: 'Otro' })
    expect(r.matchStatus).toBe('matched')
    expect(r.matchedClienteNombre).toBe('Test')
    expect(r.matchedInvoiceNumero).toBe('F-1')
  })
})
