// Tipos del motor de precios. Port de galv2-tauri/src/lib/types/index.ts.

export interface Producto {
  id: string
  descripcion: string
  precio_unitario: number
  categoria: string
  medida: string
  variante: string
  stock: number
}

export interface PrecioReferencia {
  id?: number
  categoria: string
  medida: string
  variante: string
  precio: number
}

export interface ParsedQuery {
  tokens: string[]
  dims: string[]
  base: string
  grosor: number | null
}

export interface RuleCondition {
  field: 'grosor' | 'lado_mayor' | 'lado_menor'
  operator: '>' | '<' | '>=' | '<=' | '=='
  value: number
  adjustmentType: 'percentage' | 'fixed'
  adjustmentValue: number
}

export interface PricingRule {
  id?: number
  name: string
  matchTokens: string[]
  baseCategoria: string
  baseVariante: string
  operation: 'direct' | 'percentage' | 'fixed' | 'override'
  operationValue: number
  conditions: RuleCondition[]
  enabled: boolean
  rounding: number
}

export interface PriceSuggestion {
  description: string
  price: number
  basedOn?: string
  suggested: boolean
  category?: string
  estimated?: boolean
  hint?: string
}

export interface CatalogBounds {
  maxLadoMayor: number
  maxLadoMenor: number
  maxPerimetro: number
  maxPrecio: number
}
