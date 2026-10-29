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

**Fase 4** (resolución por nombre) reduce el pool o agrega el mejor candidato.
**Fase 5** (wide search) solo corre si el pool sigue vacío y siempre muestra
opciones al usuario (nunca auto-match).

La **decisión** ocurre **inline** en el pipeline, después de las fases. Ahí se
determina `matched`, `multi_invoice`, `ambiguous` o `no_match`. **No existe una
función `resolvePoolDecision()`**: ese nombre fue un diseño planificado que nunca
se extrajo del pipeline (`src/lib/ai/voucher-pipeline.ts`).

```
┌─────────────────────────────────────────────────────────────┐
│  FASES 1–3                                                  │
│  Solo agregan entradas al candidatePool.                    │
│  Nunca setean matchStatus ni llaman registrarPago().        │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  FASE 4 — resolución por nombre (reduce/agrega al pool)     │
│  FASE 5 — wide search solo si el pool quedó vacío           │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  DECISIÓN INLINE                                            │
│  Evalúa el pool + nombre extraído + scores.                 │
│  Único lugar que asigna matchStatus.                        │
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

**Regla:** Para cada candidato, si `montoDistance(monto, saldo) === 0` AND (`score >= 0.5` **o** `isNameMatch(nombre, candidato)`), se agrega al pool como `type: 'single'`.

`isStrongNameMatch(candidato)` = `score >= NAME_MATCH_THRESHOLD (0.5)`. `isNameMatch(nombre, candidato)` = match fuerte **o** coincidencia local (`captionMatchesClient`: prefijo/tokens, ej. "Ale" → "Ale Casagrande"). Un match local con score < 0.5 es **débil**: no paga solo, pide confirmación (ver "Voucher por texto").

**Objetivo:** Reforzar candidatos donde el nombre extraído coincide con el cliente y el monto es exacto.

---

## Decisión — inline en el pipeline

Después de las Fases 1–5, el pipeline evalúa el pool completo y asigna
`matchStatus`. **No hay función extraída** (`resolvePoolDecision()` no existe);
la lógica vive en `processVoucherImage` / `processVoucherText`.

### Insumos

- `candidatePool: PoolEntry[]`
- `voucher: VoucherData` (monto, nombre_origen, nombre_cliente, …)
- `NAME_MATCH_THRESHOLD` (= 0.5)

### Reglas de decisión

| Pool | Regla |
|------|-------|
| 0 entries | Delegar a Fase 5 (wide search) |
| 1 entry `single`, sin nombre extraído | `matched` — único candidato, sin contradicción |
| 1 entry `single`, con nombre extraído y **coincide** | `matched` |
| 1 entry `single`, con nombre extraído y **NO coincide** | `ambiguous` — **name_mismatch**: preguntar confirmación |
| 1 entry `single`, nombre **débil** (score < 0.5 pero prefijo/tokens) | `ambiguous` — confirmar cliente/factura antes de pagar |
| 1 entry `single`, **sin nombre** y con monto (texto) | `ambiguous` — confirmar cliente/factura antes de pagar |
| 1 entry `sum` | `multi_invoice` — pedir confirmación |
| 2+ entries | Fase 4 filtra por score de nombre; si queda 1 → `matched`/`multi_invoice`; si no → `ambiguous` |

> En el path de **texto**, "sin nombre pero con monto" no paga directo: confirma
> el cliente encontrado (el monto es el ancla, pero la identidad no está
> corroborada). En **imagen/PDF** se mantiene el flujo histórico de staging/review.

### Scoring de nombre

El match de nombre se resuelve con dos helpers de `voucher-matching.ts`:

| Helper | Regla | Uso |
|--------|-------|-----|
| `isStrongNameMatch(c)` | `c.score >= 0.5` | Pago directo en efectivo |
| `isNameMatch(nombre, c)` | `isStrongNameMatch(c)` **o** `captionMatchesClient(nombre, c.cliente_nombre)` | Incluir el candidato en el pool |
| `selectNameCandidates(nombre, cs)` | filtra `saldo_pendiente > 0` + `isNameMatch` + ordena por score | Búsqueda por nombre (texto) |

Un candidato que entra solo por `captionMatchesClient` (score < 0.5) es **débil**:
se muestra para confirmar, nunca se paga solo. El fuzzy (Jaro-Winkler) es una
capa aparte, solo para texto sin monto (ver "Voucher por texto").

Prioridad de nombres extraídos: `nombre_origen` > `nombre_cliente`.

**Threshold:** `NAME_MATCH_THRESHOLD = 0.5` (score fuerte).

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

## Fase 4 — Resolución por nombre

Se ejecuta siempre (después de Fases 1–3), con el nombre extraído y los
candidatos de la búsqueda por nombre de Fase 3.

| Caso | Acción |
|------|--------|
| Pool > 1 y nombre confiable | Filtra el pool a las facturas con `score >= 0.5` (o caption que matchea al cliente); si queda 1, se auto-selecciona |
| Pool vacío y nombre confiable | Agrega el mejor candidato por nombre |
| Pool vacío y hay un nombre rescatable (origen/destino/caption) | Búsqueda **solo por nombre**, sin filtro de monto (Fase 4b) |
| Sin nombre | No hace nada; decide la Fase 5 |

El caption de la imagen solo filtra si **realmente matchea** un candidato: no
veta ni vacía el pool por sí solo.

---

## Fase 5 — Pago parcial / Wide search

Se ejecuta **solo si el pool quedó vacío** tras Fases 1–4.

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

## Voucher por texto (sin imagen)

El pago se puede reportar por texto, sin comprobante. El entry point es
`processVoucherText` (`src/lib/ai/voucher-pipeline.ts`); según haya monto o no,
toma dos caminos distintos.

### 1. Con monto — el monto es el ancla

Ejemplos: `"me pagaron 422000 en efectivo"`, `"Martu pagó 422000"`,
`"Ale pagó 200000 en transferencia"`.

- `engine.ts` (`isVoucherText`) acepta `monto > 0` + método **aunque no haya
  nombre** (`hasVoucherAnchor`). El nombre dejó de ser obligatorio.
- El pipeline llama `runVoucherDryRun` con el monto y el nombre (si vino):
  1. **Fase 1** busca por monto exacto sin nombre → la señal más fuerte.
  2. **Fase 3** refuerza/desempata por nombre.
  3. **Fase 5** (si el monto no es exacto) muestra facturas cercanas.
- Regla de confirmación (`processVoucherText`):
  | Caso | Acción |
  |------|--------|
  | 1 factura + nombre **fuerte** + efectivo | paga directo |
  | 1 factura + nombre **débil** (score < 0.5) | pide Confirmar/Cancelar |
  | 1 factura + **sin nombre** | pide Confirmar/Cancelar mostrando el cliente |
  | 1 factura + transferencia | pide Confirmar/Cancelar |
  | 2+ facturas / suma | A/B/C (o confirmación de suma) |
  | 0 facturas | `no_match` + `voucher_awaiting_match` (pide el nombre exacto) |
- Si el monto es parcial, el mensaje de confirmación muestra el saldo y cuánto
  queda. El pending conserva el monto parcial y el método.

### 2. Sin monto — el nombre manda (con fuzzy de respaldo)

Ejemplos: `"Martu pagó en efectivo"`, `"Ale pagó en transferencia a Jorge"`.

- `processVoucherSinMonto` busca por nombre con
  `selectNameCandidates` (`isNameMatch`: score **o** prefijo/tokens).
- **Nombre fuerte** (`score >= 0.5`) + efectivo → paga directo.
- **Nombre débil** (`score < 0.5` pero "Ale" → "Ale Casagrande") → confirma.
- **Transferencia** → confirma siempre.
- **Sin match exacto/local** → fuzzy:
  1. `findClientMatchesFuzzy(nombre)` (`src/lib/facbal/client.ts`) calcula
     **Jaro-Winkler** sobre todos los clientes (`src/lib/text/similarity.ts`),
     top 8 con `minScore 0.8`.
  2. Cada cliente sugerido se cruza con sus **facturas pendientes**
     (`matchVoucherByName` en paralelo, score >= 0.5).
  3. Resultado: 1 factura → confirmar; 2+ → A/B/C; 0 → `voucher_awaiting_match`
     y se pide el monto o el nombre completo.
- **Regla de oro:** el fuzzy solo **sugiere**, nunca paga solo. "Martu" puntúa
  más alto para Marta (0.92) que para Martina (0.874); lo que desempata es la
  factura pendiente + la confirmación del usuario.

### 3. Confirmación antes de pagar

Cuando el match es débil, no hay nombre, es transferencia o vino del fuzzy:

1. Se guarda el candidato en `voucher_context.pending` con el método original
   (`mediaMimeType: text/efectivo` o `text/transferencia`).
2. Se envían botones **Confirmar / Cancelar** (`askTransferConfirm`).
3. Confirmar → `processVoucherMessage` registra el pago con el método guardado.
4. Cancelar → no se registra nada y se limpia el pending.

### 4. Follow-up `voucher_awaiting_match`

Cuando no hay ninguna factura (ni exacta, ni local, ni fuzzy), se guarda el
estado en **`conversations.voucher_awaiting_match`** (columna jsonb separada de
`voucher_context`, TTL **5 minutos**):

```typescript
interface AwaitingClientMatch {
  metodoPago: 'Efectivo' | 'Transferencia'
  monto: number | null
  fecha: string | null
  destName: string | null
  attemptedName: string | null   // "Martu"
  createdAt: number
}
```

Mensaje: *"No encontramos facturas pendientes para Martu. ¿Me pasás el monto del
pago? También podés escribir el nombre completo como figura en el sistema."*

El motor (`planTurn`, antes del clarify/router) consume el próximo mensaje:

| Respuesta | Acción |
|-----------|--------|
| Monto puro (`422000`, `$422.000`, `422 mil`, `son 422000`) | `run_voucher_text` con `monto` + el nombre intentado |
| Nombre (`Martina`, `es Martina`, `el cliente es Martina`) | `run_voucher_text` con ese nombre y el monto guardado |
| `cancelar` / `no` / `olvidalo` | limpia y responde "no registré ningún pago" |
| Intent fuerte (gasto/asistencia/pedido) o texto que no es nombre/monto | limpia y sigue el flujo normal |

**Ciclo de vida:** se guarda antes de enviar el mensaje; se lee solo si
`createdAt` < 5 min (`VOUCHER_AWAITING_MATCH_TTL_MS`); se limpia al llegar un
voucher nuevo (`processVoucherText` / `processVoucherMessage`), con
`clear_voucher_awaiting` y con el reset `jesusdanielllavesecreta`.

**Guardas del parser:** no toma "gasté 5000" como monto (verbos de gasto/pago),
no toma fechas (`13/10`) ni nombres con dígitos, y no secuestra un intent fuerte.

### 5. Ejemplos completos

| Mensaje | Resultado |
|---------|-----------|
| `me pagaron 422000 en efectivo` | Fase 1 → F-10975 Martina → confirma cliente → paga |
| `Martu pagó en efectivo` | A/B → "Me pagó" → fuzzy → "¿Es Martina — F-10975 — $422.000?" → paga |
| `Martu pagó 422000 en efectivo` | A/B → "Me pagó" → monto exacto + nombre débil → confirma → paga |
| `Ale pago en efectivo` | A/B → "Me pagó" → nombre débil ("Ale" → "Ale Casagrande") → confirma → paga |
| `Martu` sin fuzzy | pide monto → `422000` → path con monto → confirma → paga |
| `Martu` y el usuario dice `Martina` | busca "Martina" (score fuerte) → paga/confirma transferencia |

> La compuerta A/B de la **forma pelada** (`"Ale pago en efectivo"`) sigue
> vigente: no se relajó. Después del tap, el nombre débil se confirma. Para
> eliminarla habría que cambiar `classifyPaymentIntent`/`detectAmbiguity` y sus
> tests (decisión de producto pendiente).

## Multi-turn (clarificación)

Estado persistido en `conversations.voucher_context`:

```typescript
interface VoucherContextState {
  pending: PendingVoucherItem[]
  pendingTexts: PendingTextItem[]  // buffer 60s para texto previo a imagen
}
```

`voucher_awaiting_match` vive en su propia columna
(`conversations.voucher_awaiting_match`), no dentro de `voucher_context`, para no
pisar `pending` con read-modify-write.

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
pendientes de esa conversación (pending + pendingTexts + `voucher_awaiting_match`).

---

## Edge Cases

| # | Escenario | Comportamiento |
|---|-----------|----------------|
| 1 | Pago exacto ($1000 → factura $1000), sin nombre extraído | Fase 1 → pool[1] → decisión → **matched** |
| 2 | Pago exacto a varias facturas del mismo cliente ($500 → $300 + $200) | Fase 2 → pool[1 sum] → decisión → **multi_invoice** |
| 3 | Pago con nombre + monto exacto, único candidato | Fase 3 → pool[1] con score alto → **matched** |
| 4 | Candidato ya en pool Fase 1, Fase 3 lo refuerza | Dedup — no duplica |
| 5 | Pago menor que factura ($500 → factura $1000) | Pool vacío → Fase 5 → **ambiguous** |
| 6 | Sin monto extraído | Fases 1–2 skip → Fase 3 (solo nombre) → si vacío, Fase 5 |
| 7 | 2 facturas mismo monto ($1000 = MARIA y JUAN), nombre desempata | Fase 4 → decisión → **matched** al que pasa score |
| 8 | 1 factura exacta, nombre extraído que NO coincide | pool[1] → name mismatch → **ambiguous** (pregunta confirmación) |
| 9 | Suma exacta + factura individual del mismo monto | Fase 1 + 2 → pool[2] → decisión por nombre → **ambiguous** si no desempata |
| 10 | Usuario confirma factura en `ambiguous` | **registrarPago()** + mensaje éxito |
| 11 | Timeout en Fase 5 | Pedir nombre al usuario |
| 12 | Nombre corto/apodo ("Ale" → "Ale Casagrande") con score 0.35 | `isNameMatch` local → **débil** → `ambiguous` (confirmar cliente/factura) |
| 13 | Nombre inexistente ("Martu") pero una factura de "Martina" | fuzzy Jaro-Winkler + facturas pendientes → **ambiguous** (confirmar) |
| 14 | Monto exacto sin nombre ("me pagaron 422000") | Fase 1 → **ambiguous** (confirmar cliente) |
| 15 | Sin match por nombre ni fuzzy | `no_match` + `voucher_awaiting_match` (pedir monto/nombre) |
| 16 | Follow-up con monto puro ("422000") | path con monto (Fase 1) |
| 17 | Follow-up con nombre ("Martina") | path por nombre |
| 18 | Follow-up "cancelar" o intent fuerte | limpia el awaiting y sigue el flujo normal |

---

## Extracción IA (input al matching)

Modelo: `google/gemini-2.5-flash` vía OpenRouter (`VOUCHER_AI_MODEL` override).

Campos usados en matching:

| Campo | Uso en matching |
|-------|----------------|
| `monto` | Fases 1, 2, 3, 5 |
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
- **Desempate por monto** en Fase 5 con el nombre extraído (actualmente
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
| `055_voucher_awaiting_match.sql` | Columna `conversations.voucher_awaiting_match` (follow-up "monto o nombre") |
