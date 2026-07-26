# Plan de mejoras — Reconocimiento de Vouchers

> **Estado:** En progreso — mayoría implementado (Jul 2026)
> **Spec de matching:** ver [`invoice.md`](./invoice.md)
> **Arquitectura general:** ver [`BOT_ARCHITECTURE.md`](./BOT_ARCHITECTURE.md) §3

---

## Objetivo

Endurecer el pipeline de comprobantes de pago para que:

1. **Ninguna fase confirme por sí sola** — solo acumulan candidatos en el pool.
2. **Un motor de decisión central** resuelva `matched` / `multi_invoice` / `ambiguous` / `no_match`, usando el nombre extraído por IA para desempatar cuando el monto no alcanza.
3. **Todos los caminos de confirmación registren el pago** de forma consistente.
4. **Se eliminen bugs y código legacy** que contradigan el diseño actual.
5. **Se reduzca el ruido** procesando solo comprobantes probables.

---

## Principio rector: fases = recolección, decisión = confirmación

```
┌─────────────────────────────────────────────────────────────┐
│  FASES 1–3 (y 4 como fallback)                              │
│  Solo agregan entradas al candidatePool.                    │
│  Nunca setean matchStatus ni llaman registrarPago().        │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  MOTOR DE DECISIÓN (nuevo/refactorizado)                    │
│  Evalúa el pool completo + nombre extraído + scores.       │
│  Único lugar que asigna matchStatus.                       │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  POST-DECISIÓN                                              │
│  stageVoucher → registrarPago (si aplica) → WhatsApp reply  │
└─────────────────────────────────────────────────────────────┘
```

**Regla clave:** La Fase 1 **nunca** auto-confirma. Si hoy el código hace `matched` cuando el pool tiene 1 entrada `single` sin validar nombre, eso se mueve al motor de decisión con las reglas de desempate descritas en `invoice.md`.

---

## Estado actual vs. objetivo

| Área | Hoy | Objetivo |
|------|-----|----------|
| Fases 1–3 | Acumulan pool ✅ | Mantener — verificar que ninguna fase setee status |
| Decisión post-pool | 1 `single` → `matched` sin validar nombre||
| Desempate mismo monto | 2+ entries → `ambiguous` siempre | Si nombre desempata a 1 → `matched` |
| `pickBestMatch()` | Sobrescribe invoice matched en todos los casos ❌ | Eliminar o usar solo cuando decisión = `matched` con 1 candidato |
| Clarificación `ambiguous` | Solo staging, sin `registrarPago()` ❌ | Registrar pago tras confirmación del usuario |
| Clarificación `multi_invoice` | `registrarPago()` ✅ | Mantener — unificar con ambiguous |
| Disparo del pipeline | Toda imagen/documento ❌ | Heurística + contexto pendiente |
| `matchVoucher()` legacy | ~200 líneas sin uso ❌ | Eliminar |
| DB `match_status` | `multi_invoice` → guardado como `ambiguous` ❌ | Migración para distinguir |
| Documentación | `BOT_ARCHITECTURE.md` desactualizado ❌ | Actualizado en este plan |

---

## Bloque A — Motor de decisión central

**Archivo principal:** `src/lib/ai/voucher-pipeline.ts` (extraer a función `resolvePoolDecision()`)
**Helpers:** `src/lib/ai/voucher-matching.ts`

### A.1 — Nueva función `resolvePoolDecision()`

Entrada:
- `candidatePool: PoolEntry[]`
- `voucher: VoucherData` (monto, nombre_origen, nombre_cliente, etc.)
- `nameThreshold` (= `NAME_MATCH_THRESHOLD`, 0.5)

Salida:
```typescript
interface PoolDecision {
  status: 'matched' | 'multi_invoice' | 'ambiguous' | 'no_match'
  selectedEntry?: PoolEntry          // para matched / multi_invoice
  selectedInvoice?: MatchVoucherCandidate  // para matched single
  candidates: MatchVoucherCandidate[]    // para ambiguous / staging
  mensajeRespuesta: string
  reason: string                       // para debug_info
}
```

### A.2 — Reglas de decisión (ver detalle en `invoice.md`)

| Pool | Regla |
|------|-------|
| 0 entries | Delegar a Fase 4 (wide search) |
| 1 entry `single` | Validar score de nombre → `matched` o `ambiguous` (name_mismatch) |
| 1 entry `sum` | Validar score de nombre del cliente del grupo → `multi_invoice` o `ambiguous` |
| 2+ entries | Filtrar por score de nombre; si queda 1 → `matched`/`multi_invoice`; si no → `ambiguous` |

### A.3 — Scoring de nombre en decisión

Para cada entry del pool, calcular `nameScore` usando:
1. El `score` que devolvió FacBal (si la entry vino de Fase 3), **o**
2. Una función local `scoreNameMatch(extractedName, clienteNombre)` cuando la entry vino de Fase 1/2 (sin nombre en la API call).

Prioridad de nombres extraídos: `nombre_origen` > `nombre_cliente`.

### A.4 — Casos de desempate por nombre

| Escenario | Comportamiento esperado |
|-----------|------------------------|
| $1000 = MARIA + JUAN, nombre = "Maria Garcia" | 1 pasa score → `matched` MARIA |
| $1000 = MARIA + JUAN, sin nombre extraído | `ambiguous` — listar ambas |
| $1000 = MARIA + JUAN, nombre = "Pedro Lopez" | `ambiguous` — ninguno pasa |
| $1000 solo MARIA, nombre = "Pedro Lopez" | `ambiguous` — name_mismatch, preguntar confirmación |
| $1000 solo MARIA, nombre = "Maria Garcia" | `matched` |
| $1000 solo MARIA, sin nombre | `matched` (monto único, sin contradicción) |

---

## Bloque B — Correcciones al pipeline

**Archivo:** `src/lib/ai/voucher-pipeline.ts`

### B.1 — Eliminar `pickBestMatch()` post-decisión

```typescript
// ELIMINAR (líneas ~723-729):
const matchedInfo = pickBestMatch(candidates)
if (matchedInfo) { matchedInvoiceId = ... }
```

Solo setear `matchedInvoiceId` desde el resultado de `resolvePoolDecision()`.

### B.2 — Unificar registro de pagos tras clarificación

Hoy:
- `multi_invoice` + confirmación → `registrarPago()` ✅
- `ambiguous` + elección de factura → solo `createVoucherReview()` ❌

Objetivo: ambos caminos llaman `registrarPago()` tras confirmación explícita del usuario.

Flujo unificado post-confirmación:
```
1. createVoucherReview(status: 'matched', review_status: 'completed')
2. registrarPago(invoiceId, monto, fecha)
3. WhatsApp: "Registramos tu pago para [cliente] — Factura [número]."
```

### B.3 — Verificar que fases no confirmen

Auditar Fases 1–3 y confirmar que solo llaman `tryAddToPool()`. Si alguna asigna `matchStatus`, mover esa lógica al motor de decisión.

### B.4 — Fase 2: corregir doc vs. código

`invoice.md` decía que Fase 2 reusa candidatos de Fase 1; el código hace otra llamada API con `tolerancia = monto`. Documentar el comportamiento real en `invoice.md` (ya actualizado).

---

## Bloque C — Filtrado del disparo del pipeline

**Archivo:** `src/app/api/whatsapp/webhook/route.ts`

### C.1 — Cuándo disparar `processVoucherMessage`

| Condición | Disparar |
|-----------|----------|
| Imagen/documento + caption con keywords de pago | ✅ |
| Imagen/documento + `hasPendingVoucher` | ✅ (siempre — contexto activo) |
| Imagen/documento sin caption ni contexto | ❌ (no disparar) |
| Texto + `hasPendingVoucher` | ✅ (ya existe) |

Keywords sugeridas (case-insensitive): `comprobante`, `transferencia`, `pago`, `deposito`, `depósito`, `recibo`, `voucher`, `factura`, `mercado pago`, `mp`.

### C.2 — Convivencia con Expense Bot

Si caption matchea `looksLikeExpense()` → Expense Bot, no Voucher.
Si matchea keywords de pago → Voucher, no Expense.
Si ambos o ninguno → no disparar automáticamente; opcionalmente preguntar al usuario.

### C.3 — Intent classifier (opcional, fase 2 del bloque)

Evaluar usar `classifyIntent()` como señal adicional, pero no como único gate (latencia + costo).

---

## Bloque D — Limpieza de código legacy

**Archivo:** `src/lib/ai/voucher-matching.ts`

### D.1 — Eliminar `matchVoucher()` y helpers exclusivos

Funciones a eliminar (solo usadas por `matchVoucher()`):
- `matchVoucher()`
- `buildMatched()`, `buildAmbiguous()`, `buildMultiInvoice()`, `buildNameMismatch()`
- `findClientMatches()` (si no se usa en Fase 4)

Funciones a **mantener**:
- `montoDistance()`
- `findExactClientSumMatches()`
- `NAME_MATCH_THRESHOLD`
- Nueva: `scoreNameMatch()` (si se implementa scoring local)

### D.2 — Actualizar imports en pipeline

Quitar imports de funciones eliminadas.

---

## Bloque E — Migración de base de datos

**Archivo nuevo:** `supabase/migrations/042_voucher_match_status_multi_invoice.sql`

```sql
-- Ampliar CHECK constraint para incluir multi_invoice
ALTER TABLE voucher_extractions
  DROP CONSTRAINT IF EXISTS voucher_extractions_match_status_check;

ALTER TABLE voucher_extractions
  ADD CONSTRAINT voucher_extractions_match_status_check
  CHECK (match_status IN ('matched', 'ambiguous', 'no_match', 'multi_invoice'));
```

Actualizar `saveAttempt()` en pipeline para persistir `multi_invoice` sin normalizar a `ambiguous`.

---

## Bloque F — Debug UI

**Archivo:** `src/app/(dashboard)/voucher-debug/page.tsx`

### F.1 — Mostrar motor de decisión

Agregar sección `decision` en timeline:
- Pool entries con type, clientName, total, nameScore
- Regla aplicada (`single_unique`, `name_disambiguation`, `name_mismatch`, etc.)
- Status final y reason

### F.2 — Indicar filtro de disparo

En logs/metadata: si el mensaje pasó o no el gate de keywords (cuando se implemente Bloque C).

---

## Orden de implementación

| # | Bloque | Prioridad | Dependencias |
|---|--------|-----------|--------------|
| 1 | A — Motor de decisión | 🔴 Alta | Ninguna |
| 2 | B — Fixes pipeline | 🔴 Alta | A |
| 3 | D — Limpieza legacy | 🟡 Media | A, B |
| 4 | E — Migración DB | 🟡 Media | B |
| 5 | F — Debug UI | 🟡 Media | A |
| 6 | C — Filtrado disparo | 🟢 Baja | B |

---

## Criterios de aceptación

- [ ] Fases 1–3 solo agregan al pool; ninguna asigna `matchStatus`
- [ ] 2 facturas mismo monto + nombre que desempata → `matched` automático
- [ ] 2 facturas mismo monto + sin nombre → `ambiguous` con lista
- [ ] 1 factura exacta + nombre contradictorio → `ambiguous` (pregunta confirmación)
- [ ] Usuario confirma factura en `ambiguous` → `registrarPago()` + mensaje de éxito
- [ ] Usuario confirma en `multi_invoice` → mismo flujo unificado
- [ ] `pickBestMatch()` eliminado; `matchedInvoiceId` viene solo de la decisión
- [ ] `matchVoucher()` eliminado; tests/debug no lo referencian
- [ ] `multi_invoice` persistido correctamente en DB
- [ ] Imagen sin caption ni contexto voucher → no dispara pipeline
- [ ] `debug_info.decision` muestra regla aplicada y scores de nombre
- [ ] Documentación (`invoice.md`, `BOT_ARCHITECTURE.md`, este plan) alineada con código

---

## Archivos a modificar (implementación futura)

| Archivo | Cambio |
|---------|--------|
| `src/lib/ai/voucher-pipeline.ts` | ✅ Decisión + entity linking + fecha + pickBestMatch removido |
| `src/lib/ai/voucher-matching.ts` | ✅ Limpieza (matchVoucher + helpers legacy) |
| `src/lib/ai/voucher-context.ts` | ✅ RPC atómicos para pending vouchers |
| `src/app/api/whatsapp/webhook/route.ts` | Gate de disparo (pendiente) |
| `src/app/(dashboard)/voucher-debug/page.tsx` | Timeline de decisión (pendiente) |
| `supabase/migrations/042_*.sql` | ✅ CHECK multi_invoice |
| `supabase/migrations/043_*.sql` | ✅ Funciones atómicas voucher_append/remove |
| `invoice.md` | ✅ Spec de matching actualizado |
| `BOT_ARCHITECTURE.md` | ✅ Arquitectura voucher actualizada |

---

## Vinculación de entidad (proveedor/empleado) ✅ Implementado

Los `destination_candidates` que devuelve `matchVoucherByName()` (entity_type, entity_id, entity_name) ahora se capturan en todas las fases y se pasan a `registrarPago()` y `createVoucherReview()`.

**Cambios en `pipeline.ts`:**
- `allDestinationCandidates[]` acumula destinations de Fases 1-4
- `bestDest` = candidato de mayor score (reduce en el pool acumulado)
- Los 6 call sites de `registrarPago()` envían `entityType`/`entityId` desde `bestDest`
- Los 3 payloads de `createVoucherReview()` incluyen `entity_type`/`entity_id`/`entity_name`
- `pendingItem.bestDestination` se preserva en multi-turn para confirmaciones posteriores

**Formato de fecha:** `normalizeDate()` convierte cualquier formato a `YYYY-MM-DD` (ISO) compatible con `<input type="date">`.

**Fix frontend (galv2-tauri):** `dateToInput()` en `FichaSemanal.svelte` normaliza fechas en formato argentino (`DD/MM/YYYY`) al cargar el modal de edición.

---

## Race condition: vouchers simultáneos mismo chat ✅ Implementado

Cuando WhatsApp envía múltiples imágenes en un mismo webhook, los bgTasks corren **concurrentes** al final. Si 2+ vouchers para la misma conversación terminan como `ambiguous`/`multi_invoice`, el `addPendingVoucher()` original (read-modify-write) causaba que el segundo pisara al primero.

**Solución:** Funciones PL/pgSQL atómicas (`043_voucher_atomic_pending.sql`):
- `voucher_append_pending(conv_id, new_item)` — jsonb concatenación atómica
- `voucher_remove_pending(conv_id, msg_id)` — filtrado atómico por sourceMessageId
- `voucher-context.ts` usa `db.rpc(...)` en vez de load→push→save

---

## UX: múltiples vouchers pendientes

Cuando un usuario envía varios comprobantes a la vez y todos requieren clarificación, el bot envía un mensaje por cada uno. El usuario debe responder **"sí" repetidamente** — cada respuesta procesa un pendiente en orden FIFO. El bot confirma cuál se registró en cada paso.

```
Usuario envía 3 imágenes
Bot: "Comprobante 1: ¿Confirma pago para María García?"
Bot: "Comprobante 2: ¿Confirma pago para Juan Pérez?"
Bot: "Comprobante 3: ¿Confirma pago para Carlos López?"

Usuario: "sí"
Bot: "Registramos tu pago para María García."  ← procesó el 1°
Usuario: "sí"
Bot: "Registramos tu pago para Juan Pérez."    ← procesó el 2°
Usuario: "sí"
Bot: "Registramos tu pago para Carlos López."  ← procesó el 3°
```

**Regla simple para el usuario:** responder siempre al último mensaje del bot y repetir "sí" hasta que no queden más pendientes. Si necesita clarificar un comprobante específico, incluir el número de factura o nombre del cliente.

---

## Historial

| Fecha | Cambio |
|-------|--------|
| Jul 2026 | Plan inicial de redesign (pool + 4 fases) — parcialmente implementado |
| Jul 2026 | Revisión post-audit: motor de decisión, desempate por nombre, fixes pipeline, filtrado disparo |
| Jul 2026 | Implementado: limpieza matchVoucher, eliminado pickBestMatch, multi_invoice persistido, name_mismatch |
| Jul 2026 | Implementado: entity linking (bestDest → registrarPago/createVoucherReview), fecha ISO, race condition fix (RPC atómico) |
