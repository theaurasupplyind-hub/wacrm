# Invoice Matching Flow

## Candidate Pool

Las fases 1-3 acumulan candidatos en un `candidatePool` compartido. Cada entrada tiene:

```typescript
interface PoolEntry {
  type: 'single' | 'sum'
  invoices: MatchVoucherCandidate[]
  total: number
  clientName: string
}
```

Se deduplica por `invoice_id`: si una factura ya está en el pool, no se agrega de nuevo.

---

## Fase 1 — Monto exacto individual

**API**: `matchVoucherByName` con `tolerancia: 50`, sin nombre.

**Regla**: Para cada candidato, si `montoDistance(monto, saldo) === 0`, se agrega al pool como `type: 'single'`.

**Objetivo**: Encontrar facturas cuyo saldo pendiente coincida exactamente con el monto del pago.

---

## Fase 2 — Suma exacta del mismo cliente

**Fuente**: Reusa los candidatos obtenidos en Fase 1 (no hace otra llamada API).

**Regla**: `findExactClientSumMatches` agrupa facturas del mismo cliente y suma sus saldos. Si `sum(saldos) === monto`, se agrega al pool como `type: 'sum'`.

**Objetivo**: Un pago puede cubrir varias facturas de un mismo cliente cuyo saldo total coincida exactamente.

---

## Fase 3 — Búsqueda por nombre + monto exacto

**API**: `matchVoucherByName` con `tolerancia: 50`, usando `nombre_cliente` y/o `nombre_origen` extraídos por AI.

**Regla**: Para cada candidato, si `montoDistance(monto, saldo) === 0` AND `score >= 0.5` (coincidencia de nombre), se agrega al pool como `type: 'single'`.

**Objetivo**: Encontrar facturas donde el nombre extraído por AI coincide con el cliente y el monto es exacto.

---

## Decisión post Fases 1-3

| Pool Size | Acción |
|-----------|--------|
| 0 | → Fase 4 |
| 1 (single) | `matched` — auto-confirmar |
| 1 (sum) | `multi_invoice` — preguntar confirmación |
| 2+ | `ambiguous` — mostrar todas las opciones al usuario |

---

## Fase 4 — Pago parcial / Wide search

Se ejecuta solo si el pool quedó vacío (ninguna coincidencia exacta).

**API**: `matchVoucherByName` con `tolerancia = min(max(10K, monto * 0.5), 50K)`, sin nombre.

| Condición | Acción |
|-----------|--------|
| 1-15 candidatos | Mostrar todos al usuario y preguntar |
| >15 candidatos | "Decinos el nombre exacto del cliente" — preguntar nombre |
| Timeout API | "Decinos el nombre exacto del cliente" — preguntar nombre |
| 0 candidatos | "No encontramos facturas pendientes. Un agente lo revisará." |

Cuando el usuario responde con el nombre, se usa `interpretUserResponse` para buscar entre los candidatos ya obtenidos (no se hace otra llamada API).

---

## Edge Cases

| # | Escenario | Comportamiento |
|---|-----------|----------------|
| 1 | Pago exacto ($1000 → factura $1000) | Fase 1 → matched |
| 2 | Pago exacto a varias facturas del mismo cliente ($500 → $300 + $200) | Fase 2 → multi_invoice |
| 3 | Pago con nombre extraído + monto exacto | Fase 3 → matched |
| 4 | Pago con nombre extraído + monto exacto (ya en pool de Fase 1) | Fase 3 → skip (dedup) |
| 5 | Pago menor que factura ($500 → factura $1000) | Fase 4 → mostrar o preguntar |
| 6 | Pago sin nombre extraído ni monto exacto | Fase 1-3 vacío → Fase 4 |
| 7 | Múltiples facturas con mismo monto exacto ($1000 = MARIA y JUAN) | Fase 1 → pool con 2 entries → ambiguous |
| 8 | Un cliente con suma exacta + otro cliente con factura exacta ($1000 = JUAN o MARIA $500+$500) | Fase 1 + Fase 2 → pool con 2 entries → ambiguous |
| 9 | Sin monto extraído por AI | Fase 1 y 2 skip → Fase 3 (solo nombre) → si no, Fase 4 |
| 10 | Timeout en Fase 4 | Preguntar nombre al usuario |

## Archivos

- `src/lib/ai/voucher-pipeline.ts` — Pipeline completo con Fases 1-4
- `src/lib/ai/voucher-matching.ts` — Funciones auxiliares (`montoDistance`, `findExactClientSumMatches`)
