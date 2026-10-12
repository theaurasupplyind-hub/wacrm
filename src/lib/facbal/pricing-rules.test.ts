import { describe, it, expect } from 'vitest'
import { parsePricingRule } from './client'

describe('parsePricingRule', () => {
  it('parsea una fila snake_case del backend (match_tokens/conditions como JSON string)', () => {
    const raw = {
      id: 99,
      name: 'Pinturas',
      match_tokens: '["pintura","embastado","embastar"]',
      base_categoria: 'BASTIDOR',
      base_variante: 'Sin Tela',
      operation: 'percentage',
      operation_value: 10,
      conditions:
        '[{"field":"grosor","operator":">=","value":2,"adjustmentType":"percentage","adjustmentValue":10}]',
      enabled: true,
      rounding: 1000,
    }

    expect(parsePricingRule(raw)).toEqual({
      id: 99,
      name: 'Pinturas',
      matchTokens: ['pintura', 'embastado', 'embastar'],
      baseCategoria: 'BASTIDOR',
      baseVariante: 'Sin Tela',
      operation: 'percentage',
      operationValue: 10,
      conditions: [
        { field: 'grosor', operator: '>=', value: 2, adjustmentType: 'percentage', adjustmentValue: 10 },
      ],
      enabled: true,
      rounding: 1000,
    })
  })

  it('acepta camelCase con arrays ya parseados', () => {
    const raw = {
      id: 1,
      name: 'Tapacanto',
      matchTokens: ['tapacantos', 'marco'],
      baseCategoria: 'BASTIDOR',
      baseVariante: 'Lienzo Profesional',
      operation: 'direct',
      operationValue: 0,
      conditions: [],
      enabled: true,
      rounding: 1000,
    }
    const rule = parsePricingRule(raw)
    expect(rule.matchTokens).toEqual(['tapacantos', 'marco'])
    expect(rule.conditions).toEqual([])
  })

  it('cae a defaults y arrays vacíos ante JSON inválido o campos faltantes', () => {
    const rule = parsePricingRule({
      match_tokens: 'no-json',
      conditions: '{}',
    })
    expect(rule.name).toBe('')
    expect(rule.matchTokens).toEqual([])
    expect(rule.conditions).toEqual([])
    expect(rule.baseCategoria).toBe('')
    expect(rule.operation).toBe('direct')
    expect(rule.operationValue).toBe(0)
    expect(rule.enabled).toBe(true)
    expect(rule.rounding).toBe(1000)
  })
})
