# Plan de mejoras — Reconocimiento de Vouchers

> **Estado:** Planificado — sin implementar aún (Jul 2026)
> **Spec de matching:** ver [`invoice.md`](./invoice.md)
> **Arquitectura general:** ver [`BOT_ARCHITECTURE.md`](./BOT_ARCHITECTURE.md) §3

---

## Objetivo

Endurecer el pipeline de comprobantes de pago para:

1. **Ninguna fase confirme por sí sola** — solo acumulan candidatos en el pool.
2. **La decisión evalúa el pool completo** (Fases 1–3, con Fase 4 como fallback cuando el pool queda vacío).
3. **Todos los caminos de confirmación registren el pago** de forma consistente.
4. **Se eliminen bugs y código legacy** que contradigan el diseño actual.
5. **Se reduzca el ruido** procesando solo comprobantes probables.

---

## Principio rector: fases = recolección, decisión = confirmación

```
┌─────────────────────────────────────────────────────────────┐
│  FASES 1–3                                                   │
│  Solo agregan entradas al candidatePool.                     │
│  Nunca setean matchStatus ni llaman registrarPago().         │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  DECISIÓN (inline en pipeline.ts)                            │
│  Evalúa el pool completo. Único lugar que asigna            │
│  matchStatus.                                                │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  POST-DECISIÓN                                              │
│  stageVoucher → registrarPago (si aplica) → WhatsApp reply  │
└─────────────────────────────────────────────────────────────┘

Si el pool queda vacío → Fase 4 (wide search) → siempre muestra
opciones al usuario (nunca auto-match).
```

**Regla clave:** Ninguna fase auto-confirma. Si el pool tiene 1 entry `single`
sin validar nombre, la decisión valida que no haya contradicción de nombre
antes de setear `matched`.

---

## Estado actual vs. objetivo

| Área | Hoy | Objetivo |
|------|-----|----------|
| Fases 1–3 | Acumulan pool ✅ | Mantener |
| Decisión post-pool | 1 `single` → `matched` sin validar nombre ❌ | Validar si hay nombre contradictorio → `ambiguous` si no pasa |
| `pickBestMatch()` | Sobrescribe `matchedInvoiceId` post-decisión ❌ | Eliminar — la decisión ya eligió |
| Clarificación `ambiguous` | Sin `registrarPago()` tras confirmación ❌ | Llamar `registrarPago()` igual que en `multi_invoice` |
| Clarificación `multi_invoice` | `registrarPago()` ✅ | Mantener |
| Disparo del pipeline | Toda imagen/documento ❌ | Heurística + contexto pendiente |
| `matchVoucher()` legacy | ~200 líneas sin uso ❌ | Eliminar |
| DB `multi_invoice` | Normalizado a `ambiguous` al guardar ❌ | Persistir como `multi_invoice` |

---

## Bloque 1 — Decision logic fixes (pipeline.ts)

**Archivo:** `src/lib/ai/voucher-pipeline.ts`

### 1.1 — Eliminar `pickBestMatch()` post-decisión

```typescript
// ELIMINAR (L723–729):
const matchedInfo = pickBestMatch(candidates)
if (matchedInfo) {
  matchedInvoiceId = matchedInfo.invoiceId
  ...
}
```

`pickBestMatch()` corre después de que la decisión ya seteó `matchStatus`.
Sobrescribe `matchedInvoiceId` con el candidato de mayor score, ignorando
si la decisión fue `ambiguous` o `multi_invoice`. Es un bug.
Solución: eliminarlo. La decisión ya eligió el `matchedInvoiceId` correcto.

También eliminar la función `pickBestMatch()` (L64–73).

### 1.2 — No sobrescribir `matchedInvoiceId` post-decisión

La decisión (L658–692) ya asigna `matchedInvoiceId`, `matchedInvoiceNumero`,
etc. correctamente. Después de eso, ningún código debe sobreescribirlos.

### 1.3 — Unificar `registrarPago()` en clarificación `ambiguous`

Hoy:
- `multi_invoice` + confirmación → `registrarPago()` ✅
- `ambiguous` + elección de factura → solo `createVoucherReview()` ❌

Objetivo: ambos caminos llaman `registrarPago()` tras confirmación explícita.

Flujo unificado post-confirmación:
```
1. createVoucherReview(status: 'matched', review_status: 'completed')
2. registrarPago(invoiceId, monto, fecha)
3. WhatsApp: "Registramos tu pago para [cliente] — Factura [número]."
```

### 1.4 — Validar nombre en decisión "1 single → matched"

El bloque de decisión (L658–670) asigna `matched` cuando hay 1 entry `single`,
pero no verifica el nombre extraído. Si el nombre extraído contradice al
cliente de la factura, debería ir a `ambiguous` (name_mismatch).

Regla: si `nombre_origen` o `nombre_cliente` fueron extraídos, comparar
contra `entry.clientName`. Si no hay match de nombre → `ambiguous` con
pregunta de confirmación. Si no se extrajo nombre → `matched` (no hay
contradicción).

---

## Bloque 2 — Limpieza de código legacy

**Archivo:** `src/lib/ai/voucher-matching.ts`

### 2.1 — Eliminar `matchVoucher()` y helpers exclusivos

`matchVoucher()` no tiene callers en el código actual. El pipeline usa
la decisión inline. Se eliminan:

| Función | Motivo |
|---------|--------|
| `matchVoucher()` | Sin uso |
| `buildMatched()` | Solo usada por `matchVoucher` |
| `buildAmbiguous()` | Solo usada por `matchVoucher` |
| `buildMultiInvoice()` | Solo usada por `matchVoucher` |
| `buildNameMismatch()` | Solo usada por `matchVoucher` |
| `findClientMatches()` | Sin uso |
| `MatchResult` interface | Solo usada por `matchVoucher` |

Funciones a **mantener**:
- `montoDistance()`
- `getMontoTolerancia()`, `getMontoGapMin()`
- `findExactClientSumMatches()`
- `NAME_MATCH_THRESHOLD`
- `MatchStatus` type

### 2.2 — Actualizar imports en pipeline

Quitar imports de funciones eliminadas (ninguna se importa actualmente
desde pipeline.ts, solo `findExactClientSumMatches`, `montoDistance`,
`NAME_MATCH_THRESHOLD` y `MatchStatus`).

---

## Bloque 3 — Migración de base de datos

**Archivo nuevo:** `supabase/migrations/042_voucher_match_status_multi_invoice.sql`

```sql
ALTER TABLE voucher_extractions
  DROP CONSTRAINT IF EXISTS voucher_extractions_match_status_check;

ALTER TABLE voucher_extractions
  ADD CONSTRAINT voucher_extractions_match_status_check
  CHECK (match_status IN ('matched', 'ambiguous', 'no_match', 'multi_invoice'));
```

**Pipeline.ts:** cambiar `saveAttempt()` (L962) para persistir
`multi_invoice` sin normalizar a `ambiguous`.

---

## Bloque 4 — Filtrado del disparo del pipeline

**Archivo:** `src/app/api/whatsapp/webhook/route.ts`

### 4.1 — Cuándo disparar `processVoucherMessage`

| Condición | Disparar |
|-----------|----------|
| Imagen/documento + caption con keywords de pago | ✅ |
| Imagen/documento + `hasPendingVoucher` | ✅ (siempre — contexto activo) |
| Imagen/documento sin caption ni contexto | ❌ (no disparar) |
| Texto + `hasPendingVoucher` | ✅ (ya existe) |

Keywords (case-insensitive): `comprobante`, `transferencia`, `pago`,
`deposito`, `depósito`, `recibo`, `voucher`, `factura`, `mercado pago`, `mp`.

### 4.2 — Convivencia con Expense Bot

Si caption matchea `looksLikeExpense()` → Expense Bot, no Voucher.
Si matchea keywords de pago → Voucher, no Expense.
Si ambos o ninguno → no disparar automáticamente.

---

## Bloque 5 — Debug UI

**Archivo:** `src/app/(dashboard)/voucher-debug/page.tsx`

- Asegurar que `debugInfo.final` refleje el resultado post-decisión (hoy
  se setea antes de `pickBestMatch()`, que ya no va a existir)
- Mostrar en timeline si el mensaje pasó el gate de keywords (Bloque 4)

---

## Orden de implementación

| # | Bloque | Prioridad |
|---|--------|-----------|
| 1 | Bloque 2 — Limpieza legacy | 🔴 Alta |
| 2 | Bloque 1 — Decision fixes | 🔴 Alta |
| 3 | Bloque 3 — Migración DB | 🔴 Alta |
| 4 | Bloque 5 — Debug UI | 🟡 Media |
| 5 | Bloque 4 — Filtrado disparo | 🟢 Baja |

---

## Criterios de aceptación

- [ ] `pickBestMatch()` eliminado; `matchedInvoiceId` viene solo de la decisión
- [ ] `matchVoucher()` y sus helpers eliminados; no hay imports rotos
- [ ] `multi_invoice` persistido correctamente en DB (CHECK constraint actualizada)
- [ ] 1 factura exacta + nombre contradictorio → `ambiguous` (pregunta confirmación)
- [ ] Usuario confirma factura en `ambiguous` → `registrarPago()` + mensaje de éxito
- [ ] Usuario confirma en `multi_invoice` → mismo flujo unificado
- [ ] Imagen sin caption ni contexto voucher → no dispara pipeline
- [ ] Imagen con caption de pago + sin contexto → dispara pipeline
- [ ] Documentación (`invoice.md`, `BOT_ARCHITECTURE.md`, este plan) alineada con código

---

## Archivos a modificar

| Archivo | Cambio |
|---------|--------|
| `src/lib/ai/voucher-pipeline.ts` | Eliminar `pickBestMatch()`, fix nombre en decisión, unificar `registrarPago()` en ambiguous, no normalizar `multi_invoice` |
| `src/lib/ai/voucher-matching.ts` | Eliminar `matchVoucher()` y helpers sin uso |
| `src/app/api/whatsapp/webhook/route.ts` | Gate de disparo (Bloque 4) |
| `src/app/(dashboard)/voucher-debug/page.tsx` | Timeline sincronizado |
| `supabase/migrations/042_*.sql` | CHECK constraint + `multi_invoice` |
| `invoice.md` | Spec de matching ✅ se actualiza en paralelo |
| `BOT_ARCHITECTURE.md` | Sección voucher ✅ se actualiza en paralelo |

---

## Historial

| Fecha | Cambio |
|-------|--------|
| Jul 2026 | Plan inicial de redesign (pool + 4 fases) — parcialmente implementado |
| Jul 2026 | Revisión post-audit: corrección de plan, eliminación de `pickBestMatch`, `matchVoucher`, fix `multi_invoice` |
