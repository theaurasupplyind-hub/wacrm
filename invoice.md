# Invoice Matching Flow

> **Implementación:** `src/lib/ai/voucher-pipeline.ts`
> **Plan de mejoras pendientes:** [`plan.md`](./plan.md)
> **Helpers:** `src/lib/ai/voucher-matching.ts`

---

## Principio: fases recolectan, decisión confirma

Las **Fases 1–3** **solo agregan entradas al pool**. Ninguna fase asigna `matchStatus`, envía mensajes finales ni llama `registrarPago()`.

Si el pool queda vacío tras Fases 1–3, se ejecuta **Fase 4** (wide search) como fallback. Fase 4 siempre muestra opciones al usuario (nunca auto-match).

La **decisión** ocurre inline después de las fases de recolección. Es el único lugar donde se determina `matched`, `multi_invoice`, `ambiguous` o `no_match`.

---

## Candidate Pool

Las fases 1–3 acumulan candidatos en un `candidatePool` compartido. Cada entrada tiene:

```typescript
interface PoolEntry {
  type: 'single' | 'sum'
  invoices: MatchVoucherCandidate[]
  total: number
  clientName: string
}
```

**Deduplicación:** por `invoice_id` — si una factura ya está en el pool, no se agrega de nuevo.

---

## Fase 1 — Monto exacto individual

**API:** `matchVoucherByName` con `tolerancia: 50`, sin nombre.

**Regla:** Para cada candidato, si `montoDistance(monto, saldo) === 0`, se agrega al pool como `type: 'single'`.

**Objetivo:** Encontrar facturas cuyo saldo pendiente coincida exactamente con el monto del pago.

---

## Fase 2 — Suma exacta del mismo cliente

**API:** `matchVoucherByName` con `tolerancia = monto` (scan amplio de facturas con saldo < monto).

**Regla:** `findExactClientSumMatches(monto, candidates)` agrupa facturas del mismo cliente. Si `sum(saldos) === monto`, se agrega al pool como `type: 'sum'`.

**Objetivo:** Un pago puede cubrir varias facturas de un mismo cliente cuyo saldo total coincida exactamente.

---

## Fase 3 — Búsqueda por nombre + monto exacto

**API:** `matchVoucherByName` con `tolerancia: 50`, usando `nombre_cliente`, `nombre_origen`, CBU/CUIT extraídos por IA.

**Regla:** Para cada candidato, si `montoDistance(monto, saldo) === 0` AND `score >= 0.5`, se agrega al pool como `type: 'single'`.

**Objetivo:** Reforzar candidatos donde el nombre extraído coincide con el cliente y el monto es exacto.

---

## Decisión — post Fases 1–3

Después de ejecutar Fases 1–3, se evalúa el pool completo.

### Tabla de decisión

| Pool | Acción |
|------|--------|
| 0 entries | → Fase 4 (wide search, ver abajo) |
| 1 entry `single`, sin nombre extraído | `matched` — único candidato, sin contradicción |
| 1 entry `single`, con nombre extraído y **coincide** | `matched` |
| 1 entry `single`, con nombre extraído y **NO coincide** | `ambiguous` — **name_mismatch**: preguntar confirmación |
| 1 entry `sum` | `multi_invoice` — pedir confirmación |
| 2+ entries | **ambiguous** — mostrar todas las opciones al usuario |

> Si hay 2+ entries con el mismo monto exacto, el desempate por nombre
> se considera una mejora futura. Hoy se muestra `ambiguous` siempre.

### Scoring de nombre

Cuando la decisión necesita validar nombre (1 entry con nombre extraído),
usa el `score` que devolvió la API de FacBal. No hay scoring local.
El score de Fase 3 ya refleja la coincidencia nombre + monto.

**Threshold:** `NAME_MATCH_THRESHOLD = 0.5`

---

## Fase 4 — Pago parcial / Wide search

Se ejecuta **solo si el pool quedó vacío** tras Fases 1–3.

**API:** `matchVoucherByName` con `tolerancia = min(max(10K, monto * 0.5), 50K)`, sin nombre.

| Condición | Acción |
|-----------|--------|
| 1–15 candidatos | `ambiguous` — mostrar todos al usuario |
| >15 candidatos | `ambiguous` — "Decinos el nombre exacto del cliente" |
| Timeout API | `ambiguous` — pedir nombre |
| 0 candidatos | `no_match` — "Un agente lo revisará" |

Cuando el usuario responde con el nombre, se usa `interpretUserResponse()` sobre los candidatos ya obtenidos (sin nueva llamada API).

---

## Post-decisión — acciones

| Status | Staging | Pago automático | WhatsApp | Contexto |
|--------|---------|-----------------|----------|----------|
| `matched` | `createVoucherReview(completed)` | `registrarPago()` | Confirmación | — |
| `multi_invoice` | `createVoucherReview(ambiguous)` | Tras confirmación usuario | Pregunta confirmación | `addPendingVoucher(multiInvoice: true)` |
| `ambiguous` | `createVoucherReview(ambiguous)` | Tras confirmación usuario | Lista opciones / pregunta | `addPendingVoucher()` |
| `no_match` | `createVoucherReview(no_match)` | — | Deriva a agente | — |

> **Planificado (plan.md Bloque 1.3):** Hoy la clarificación `ambiguous` no llama `registrarPago()`. El objetivo es unificar ambos caminos.

---

## Edge Cases

| # | Escenario | Comportamiento |
|---|-----------|----------------|
| 1 | Pago exacto ($1000 → factura $1000), sin nombre extraído | Fase 1 → pool[1] → decisión → **matched** |
| 2 | Pago exacto a varias facturas del mismo cliente ($500 → $300 + $200) | Fase 2 → pool[1 sum] → decisión → **multi_invoice** |
| 3 | Pago con nombre + monto exacto, único candidato | Fase 3 → pool[1] con score alto → **matched** |
| 4 | Candidato ya en pool Fase 1, Fase 3 lo refuerza | Dedup — no duplica |
| 5 | Pago menor que factura ($500 → factura $1000) | Pool vacío → Fase 4 → **ambiguous** |
| 6 | Sin monto extraído | Fases 1–2 skip → Fase 3 (solo nombre) → si vacío, Fase 4 |
| 7 | **2 facturas mismo monto ($1000 = MARIA y JUAN)** | Fase 1 → pool[2] → **ambiguous** |
| 8 | 1 factura exacta, nombre extraído que NO coincide | pool[1] → name mismatch → **ambiguous** (pregunta confirmación) |
| 9 | Suma exacta + factura individual del mismo monto | Fase 1 + 2 → pool[2] → **ambiguous** |
| 10 | Usuario confirma factura en ambiguous | **registrarPago()** + mensaje éxito (pendiente Bloque 1.3) |
| 11 | Timeout en Fase 4 | Pedir nombre al usuario |

---

## Multi-turn (clarificación)

Estado persistido en `conversations.voucher_context`:

```typescript
interface VoucherContextState {
  pending: PendingVoucherItem[]
  pendingTexts: PendingTextItem[]  // buffer 60s para texto previo a imagen
}
```

**Respuestas interpretadas:**
- `interpretUserResponse()` — número de factura o tokens de nombre (ambiguous)
- `interpretMultiInvoiceResponse()` — "sí", "todas", números separados por coma (multi_invoice)

---

## Extracción IA (input al matching)

Modelo: `google/gemini-2.5-flash` vía OpenRouter (`VOUCHER_AI_MODEL` override).

Campos usados en matching:

| Campo | Uso en matching |
|-------|----------------|
| `monto` | Fases 1, 2, 3, 4 |
| `nombre_origen` | Fase 3 API + validación en decisión |
| `nombre_cliente` | Fallback de nombre en decisión |
| `nombre_destino`, `cbu_destino`, `cuit_destino` | Fase 3 API |
| `fecha` | `registrarPago()` |
| `referencia`, `banco` | Staging / auditoría |

---

## Archivos

| Archivo | Rol |
|---------|-----|
| `src/lib/ai/voucher-pipeline.ts` | Orquestador + fases + decisión + post-acciones |
| `src/lib/ai/voucher-matching.ts` | `montoDistance`, `findExactClientSumMatches` |
| `src/lib/ai/voucher-extraction.ts` | Extracción IA multimodal |
| `src/lib/ai/voucher-context.ts` | Estado multi-turn |
| `src/lib/facbal/client.ts` | `matchVoucherByName`, `createVoucherReview`, `registrarPago` |
| `src/app/(dashboard)/voucher-debug/page.tsx` | Timeline de fases + decisión |
| `supabase/migrations/031_*.sql` | Tabla `voucher_extractions` |
| `supabase/migrations/040_*.sql` | Columna `voucher_context` |
| `supabase/migrations/041_*.sql` | Columna `debug_info` |
