import { describe, it, expect } from 'vitest'
import { generateAssistantReply } from './responder'
import type { UnifiedExtraction } from '@/lib/bot-llm/types'

/**
 * Probe LIVE de calidad de respuesta (Fase 5 del plan agente-conversacional).
 *
 * 5 escenarios fijos (extracción + toolResults enlatados) por `ASSISTANT_MODEL`.
 * Imprime las respuestas para rúbrica humana (rioplatense, grounding, tono);
 * solo afirma invariantes duras (no vacía, no filtra JSON crudo).
 *
 * Correr: `$env:OPENROUTER_API_KEY="..."; npx vitest run respuesta-eval.live`
 * Comparar: `$env:ASSISTANT_MODEL="deepseek/deepseek-v4.1-flash"; ...`
 */
const HAS_KEY = !!process.env.OPENROUTER_API_KEY

function ext(over: Partial<UnifiedExtraction> = {}): UnifiedExtraction {
  return {
    intent: 'otro',
    confianza: 'alta',
    extractor_source: 'llm',
    empleado: null,
    hora: null,
    estado: null,
    monto: null,
    categoria: null,
    tipo_gasto: null,
    saldo_pendiente: null,
    proveedor: null,
    empleado_gasto: null,
    destino: null,
    metodo_pago: null,
    fecha: null,
    faltan_campos: [],
    dudoso: false,
    razon_duda: null,
    raw: '',
    ...over,
  }
}

const SCENARIOS: { name: string; historyText: string; extraction: UnifiedExtraction; toolResults: Record<string, unknown> }[] = [
  {
    name: 'gasto registrado',
    historyText: 'user: pagué 18 mil de luz',
    extraction: ext({ intent: 'gasto', monto: 18000, categoria: 'Luz', proveedor: 'Edesur', raw: 'pagué 18 mil de luz' }),
    toolResults: { expense_preview: { inferred: true, categoryName: 'Luz', providerName: 'Edesur' } },
  },
  {
    name: 'deuda con 2 candidatos',
    historyText: 'user: cuánto debe Aldo?',
    extraction: ext({ intent: 'factura', proveedor: 'Aldo', raw: 'cuánto debe Aldo?' }),
    toolResults: {
      deuda_cliente: {
        invoices: [
          { factura: 'F-101', cliente: 'Aldo Chiappe', saldo: 50000, fecha: '2026-10-01', score: 0.7 },
          { factura: 'F-102', cliente: 'Aldo García', saldo: 20000, fecha: '2026-10-03', score: 0.65 },
        ],
        total: 70000,
      },
    },
  },
  {
    name: 'falta monto',
    historyText: 'user: anotá un gasto de luz',
    extraction: ext({ intent: 'gasto', categoria: 'Luz', faltan_campos: ['monto'], raw: 'anotá un gasto de luz' }),
    toolResults: {},
  },
  {
    name: 'capacidades',
    historyText: 'user: qué podés hacer?',
    extraction: ext({ intent: 'otro', raw: 'qué podés hacer?' }),
    toolResults: {},
  },
  {
    name: 'asistencia registrada',
    historyText: 'user: llegó juan a las 8:30',
    extraction: ext({ intent: 'asistencia_llegada', empleado: 'Juan', hora: '8:30', raw: 'llegó juan a las 8:30' }),
    toolResults: { employees: [{ id: 3, name: 'Juan' }] },
  },
]

describe.skipIf(!HAS_KEY)('respuesta eval live (Fase 5: rúbrica humana)', () => {
  it('genera 5 respuestas e imprime para evaluar', async () => {
    console.log(`[respuesta-eval] modelo: ${process.env.ASSISTANT_MODEL || 'default (gemini-2.5-flash-lite)'}`)
    for (const s of SCENARIOS) {
      const reply = await generateAssistantReply({
        historyText: s.historyText,
        extraction: s.extraction,
        toolResults: s.toolResults,
        knowledge: [],
      })
      console.log(`\n--- ${s.name} ---\n${reply}\n`)
      // Invariantes duras: no vacía, no filtra JSON crudo de evidencia.
      expect(reply.trim().length).toBeGreaterThan(0)
      expect(reply).not.toMatch(/"factura":\s*"F-101"/)
    }
  }, 300_000)
})
