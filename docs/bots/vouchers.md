# Voucher Processing — especificación de matching

> Fuente única (español) para el pipeline de comprobantes de pago.
> **Estado:** implementado (excepto lo marcado en [Pendientes](#mejoras-pendientes)).
> También existe una descripción en inglés de la implementación en
> [`docs/voucher-flow.md`](../voucher-flow.md).
> Arquitectura general: [`architecture.md`](./architecture.md) §3.

**Implementación:** `src/lib/ai/voucher-pipeline.ts`
**Helpers:** `src/lib/ai/voucher-matching.ts`

---

## Principio rector: fases recolectan, decisión confirma

Las **Fases 1–3** **solo agregan entradas al pool**. Ninguna fase asigna
`matchStatus`, envía mensajes finales ni llama `registrarPago()`.

Si el pool queda vacío tras Fases 1–3, se ejecuta **Fase 4** (wide search) como
fallback. Fase 4 siempre muestra opciones al usuario (nunca auto-match).

La **decisión** ocurre inline después de las fases de recolección. Es el único
lugar donde se determina `matched`, `multi_invoice`, `ambiguous` o `no_match`.

```
┌─────────────────────────────────────────────────────────────┐
│  FASES 1–3 (y 4 como fallback)                              │
│  Solo agregan entradas al candidatePool.                    │
│  Nunca setean matchStatus ni llaman registrarPago().        │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  MOTOR DE DECISIÓN (resolvePoolDecision)                    │
│  Evalúa el pool completo + nombre extraído + scores.        │
│  Único lugar que asigna matchStatus.                       │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  POST-DECISIÓN                                              │
│  stageVoucher → registrarPago (si aplica) → WhatsApp reply  │
└─────────────────────────────────────────────────────────────┘
```

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

## Motor de decisión — `resolvePoolDecision()`

Después de ejecutar Fases 1–3, se evalúa el pool completo. Es el **único** lugar
que asigna `matchStatus`.

### Entrada

- `candidatePool: PoolEntry[]`
- `voucher: VoucherData` (monto, nombre_origen, nombre_cliente, …)
- `nameThreshold` (= `NAME_MATCH_THRESHOLD`, 0.5)

### Salida

```typescript
interface PoolDecision {
  status: 'matched' | 'multi_invoice' | 'ambiguous' | 'no_match'
  selectedEntry?: PoolEntry
  selectedInvoice?: MatchVoucherCandidate
  candidates: MatchVoucherCandidate[]
  mensajeRespuesta: string
  reason: string
}
```

### Reglas de decisión

| Pool | Regla |
|------|-------|
| 0 entries | Delegar a Fase 4 (wide search) |
| 1 entry `single`, sin nombre extraído | `matched` — único candidato, sin contradicción |
| 1 entry `single`, con nombre extraído y **coincide** | `matched` |
| 1 entry `single`, con nombre extraído y **NO coincide** | `ambiguous` — **name_mismatch**: preguntar confirmación |
| 1 entry `sum` | `multi_invoice` — pedir confirmación |
| 2+ entries | Filtrar por score de nombre; si queda 1 → `matched`/`multi_invoice`; si no → `ambiguous` |

### Scoring de nombre

Para cada entry del pool, calcular `nameScore` usando:

1. El `score` que devolvió FacBal (si la entry vino de Fase 3), **o**
2. Una función local de scoring cuando la entry vino de Fase 1/2 (sin nombre en la API call).

Prioridad de nombres extraídos: `nombre_origen` > `nombre_cliente`.

**Threshold:** `NAME_MATCH_THRESHOLD = 0.5`

### Casos de desempate por nombre

| Escenario | Comportamiento esperado |
|-----------|------------------------|
| $1000 = MARIA + JUAN, nombre = "Maria Garcia" | 1 pasa score → `matched` MARIA |
| $1000 = MARIA + JUAN, sin nombre extraído | `ambiguous` — listar ambas |
| $1000 = MARIA + JUAN, nombre = "Pedro Lopez" | `ambiguous` — ninguno pasa |
| $1000 solo MARIA, nombre = "Pedro Lopez" | `ambiguous` — name_mismatch, preguntar confirmación |
| $1000 solo MARIA, nombre = "Maria Garcia" | `matched` |
| $1000 solo MARIA, sin nombre | `matched` (monto único, sin contradicción) |

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

| Status | Staging | Pago | WhatsApp | Contexto |
|--------|---------|------|----------|----------|
| `matched` | `createVoucherReview(completed)` | `registrarPago()` automático | Confirmación | — |
| `multi_invoice` | `createVoucherReview(ambiguous)` | Tras confirmación del usuario | Pregunta confirmación | `addPendingVoucher(multiInvoice: true)` |
| `ambiguous` | `createVoucherReview(ambiguous)` | Tras confirmación del usuario | Lista opciones / pregunta | `addPendingVoucher()` |
| `no_match` | `createVoucherReview(no_match)` | — | Deriva a agente | — |

> **Unificado (implementado):** tanto `ambiguous` como `multi_invoice` llaman
> `registrarPago()` cuando el usuario confirma la factura elegida, con el mismo
> flujo de éxito (staging `completed` + mensaje de confirmación).

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

**Race condition resuelta (implementado):** si llegan 2+ vouchers simultáneos en
el mismo webhook, las escrituras a `voucher_context` usan RPCs atómicas
(`voucher_append_pending`, `voucher_remove_pending`) en vez de read-modify-write.

### Cola de múltiples vouchers

1. Vouchers **no ambiguos** se resuelven al instante.
2. Vouchers **ambiguos** se encolan en el contexto pendiente.
3. Solo se muestran los candidatos del **primero** pendiente.
4. Al resolverlo, se muestran automáticamente los del **siguiente**.
5. Continúa hasta resolver todos.

Si llega un voucher ambiguo mientras hay otros pendientes: se procesa y guarda,
se suprime el mensaje de candidatos (solo "comprobante guardado"), y se muestran
al resolverse los anteriores.

### Comando de reset

Enviar el texto `jesusdanielllavesecreta` limpia todo el contexto de vouchers
pendientes de esa conversación (pending + pendingTexts).

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
| 7 | 2 facturas mismo monto ($1000 = MARIA y JUAN), nombre desempata | Decisión → **matched** al que pasa score |
| 8 | 1 factura exacta, nombre extraído que NO coincide | pool[1] → name mismatch → **ambiguous** (pregunta confirmación) |
| 9 | Suma exacta + factura individual del mismo monto | Fase 1 + 2 → pool[2] → decisión por nombre → **ambiguous** si no desempata |
| 10 | Usuario confirma factura en `ambiguous` | **registrarPago()** + mensaje éxito |
| 11 | Timeout en Fase 4 | Pedir nombre al usuario |

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
| `fecha` | `registrarPago()` (normalizada a ISO `YYYY-MM-DD`) |
| `referencia`, `banco` | Staging / auditoría |

---

## Vinculación de entidad (proveedor/empleado) ✅ Implementado

Los `destination_candidates` que devuelve `matchVoucherByName()` (entity_type,
entity_id, entity_name) se capturan en todas las fases y se pasan a
`registrarPago()` y `createVoucherReview()`. `bestDest` = candidato de mayor
score; se preserva en multi-turn para confirmaciones posteriores.

---

## Mejoras pendientes

- **Bloque C — Filtrado del disparo del pipeline.** Hoy el webhook dispara
  `processVoucherMessage()` para toda imagen/documento. Objetivo: disparar solo
  cuando (a) el caption tiene keywords de pago (`comprobante`, `transferencia`,
  `pago`, `deposito`, `recibo`, `voucher`, `factura`, `mercado pago`, `mp`) o
  (b) hay contexto voucher pendiente. Convivencia con Expense Bot: si el caption
  matchea `looksLikeExpense()` → Expense, si matchea keywords de pago → Voucher.
- **Bloque F — Debug UI.** Mostrar la sección `decision` en el timeline
  (pool entries con nameScore, regla aplicada, status final y reason) y
  registrar si el mensaje pasó o no el gate de keywords.
- **Desempate por monto** en Fase 4 con el nombre extraído (actualmente
  `interpretUserResponse()` filtra por tokens).

---

## Archivos

| Archivo | Rol |
|---------|-----|
| `src/lib/ai/voucher-pipeline.ts` | Orquestador + fases + decisión + post-acciones |
| `src/lib/ai/voucher-matching.ts` | `montoDistance`, `findExactClientSumMatches`, thresholds |
| `src/lib/ai/voucher-extraction.ts` | Extracción IA multimodal |
| `src/lib/ai/voucher-context.ts` | Estado multi-turn (RPCs atómicos) |
| `src/lib/facbal/client.ts` | `matchVoucherByName`, `createVoucherReview`, `registrarPago` |
| `src/app/(dashboard)/voucher-debug/page.tsx` | Timeline de fases + decisión |
| `src/app/api/whatsapp/webhook/route.ts` | Disparo del pipeline (gate pendiente) |

### Migraciones

| Migration | Contenido |
|-----------|-----------|
| `031_voucher_extractions.sql` | Tabla `voucher_extractions` (auditoría) |
| `040_voucher_context.sql` | Columna `conversations.voucher_context` |
| `041_voucher_debug_info.sql` | Columna `voucher_extractions.debug_info` |
| `042_voucher_match_status_multi_invoice.sql` | CHECK incluye `multi_invoice` |
| `043_voucher_atomic_pending.sql` | RPCs atómicos `voucher_append_pending` / `voucher_remove_pending` |
