# Voucher Matching Redesign

## Objetivo

Reestructurar el matching de comprobantes de pago en 3 capas priorizadas:
1. **Match exacto por monto** + validación de nombre
2. **Suma exacta de saldos** del mismo cliente + validación de nombre
3. **Fallback**: mostrar todas las opciones posibles al usuario

## Problemas actuales

| # | Problema | Archivo | Línea |
|---|----------|---------|-------|
| 1 | `bestDist===0` auto-matchea sin verificar si hay múltiples exactos | `voucher-matching.ts` | 162 |
| 2 | Match exacto no valida el nombre extraído por AI | `voucher-matching.ts` | 171 |
| 3 | `findClientMatches` usa tolerancia ±50 en vez de priorizar match exacto (`dist===0`) | `voucher-matching.ts` | 40 |
| 4 | No se muestran todas las opciones (individuales + sumas) al usuario en Phase 3 | `voucher-pipeline.ts` | Phase 3 |
| 5 | No se indica cuántos clientes/opciones posibles hay al preguntar | `voucher-pipeline.ts` | Phase 3 |
| 6 | No hay "permitir corrección del usuario" cuando se hace una inferencia | `voucher-context.ts` | — |

## Nuevo flujo

```
Phase 1: Amount-only search (tolerancia = max(10000, monto))

  ├─ Paso 1: Match exacto individual
  │   byMonto.filter(monto <= saldo + 50).sort(by distance)
  │
  │   ┌─ bestDist === 0 ─────────────────────────────────────┐
  │   │                                                       │
  │   ├─ only 1 con dist=0 ─── validar nombre ───────────────┤
  │   │   ├─ score >= 0.5 → matched ✓                        │
  │   │   └─ score < 0.5 → preguntar "encontramos la         │
  │   │       factura X de [cliente], ¿es correcta?"          │
  │   │                                                       │
  │   ├─ múltiples con dist=0 ─── byName filter ─────────────┤
  │   │   ├─ 1 pasa → matched ✓                              │
  │   │   └─ 0 o varios → preguntar cuál                     │
  │   │                                                       │
  │   └─ bestDist > 0 ───────────────────────────────────────┤
  │       ├─ gap >= 10 → matched ✓ (ya existe)               │
  │       └─ gap < 10 → byName filter → matched/ambiguous     │
  │                                                           │
  ├─ Paso 2: Suma exacta de saldos del mismo cliente          │
  │   findExactClientSumMatches (dist === 0)                  │
  │   │                                                       │
  │   ├─ 0 clientes → seguir a Paso 3                        │
  │   ├─ 1 cliente ─── validar nombre ───────────────────────┤
  │   │   ├─ score >= 0.5 → multi_invoice (preguntar         │
  │   │   │   confirmación al usuario)                        │
  │   │   └─ score < 0.5 → preguntar al usuario              │
  │   └─ múltiples clientes → preguntar cuál                  │
  │                                                           │
  └─ Paso 3: Cercanos + preguntar
      findClientMatches (tolerancia ±50)
      + guardar TODAS las opciones para Phase 3

Phase 2: Name-based search (solo si Phase 1 no_match o ambiguous)
  └─ Mismo flujo que Phase 1 pero con nombre extraído + tolerancia=50

Phase 3: Ask user
  ├─ Mostrar todas las opciones disponibles:
  │   • Facturas individuales cercanas al monto
  │   • Sumas de facturas del mismo cliente cercanas al monto
  │   • Cantidad de clientes posibles
  │   • Cantidad de combinaciones posibles
  └─ Mensaje: "Recibimos un pago de $9500. Hay 3 clientes
      posibles (MARIA, JUAN, FEDE) con facturas cerca de
      ese monto. Decinos el nombre exacto o el número de factura."
```

## Cambios en archivos

### 1. `src/lib/ai/voucher-matching.ts`

**a) Separar `bestDist===0` en simple vs. múltiple (línea 162)**

```typescript
// ANTES:
if (bestDist === 0 || gap >= MONTO_GAP_MIN) {

// DESPUÉS:
if (bestDist === 0) {
  if (byMonto.length > 1 && montoDistance(monto, byMonto[1].saldo_pendiente) === 0) {
    // Multiple exact matches → disambiguate by name (fall through to byName)
  } else {
    if (best.score >= NAME_MATCH_THRESHOLD) {
      return buildMatched(...)
    } else {
      return buildNameMismatch(best, nombreOrigen, monto, bestDest)
    }
  }
} else if (gap >= MONTO_GAP_MIN) {
  return buildMatched(...)
}
```

**b) Agregar función `buildNameMismatch`**

```typescript
function buildNameMismatch(
  best: MatchVoucherCandidate,
  nombreOrigen: string | null,
  monto: number | null,
  bestDest: DestinationCandidate | null,
): MatchResult {
  const msg = `El pago de ${formatMonto(monto ?? best.saldo_pendiente)} coincide exactamente con la factura ${best.numero_factura} de ${best.cliente_nombre}, pero el nombre del remitente es "${nombreOrigen}". ¿Es correcto?\n\nRespondé "sí" para confirmar o decinos el nombre correcto.`
  return { status: 'ambiguous', mensajeRespuesta: msg, matchedInvoiceId: null, candidatas: [best], bestDestination: bestDest }
}
```

**c) Separar `findClientMatches` en exacta y cercana**

```typescript
export function findExactClientSumMatches(
  monto: number,
  candidates: MatchVoucherCandidate[],
): { clientName: string; invoices: MatchVoucherCandidate[]; total: number }[] {
  const groups = new Map<string, MatchVoucherCandidate[]>()
  for (const c of candidates) {
    const key = c.cliente_nombre?.trim().toLowerCase() || 'sin nombre'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(c)
  }
  const results: { clientName: string; invoices: MatchVoucherCandidate[]; total: number }[] = []
  for (const [_, invoices] of groups) {
    const total = invoices.reduce((s, inv) => s + inv.saldo_pendiente, 0)
    if (montoDistance(monto, total) === 0) {
      results.push({
        clientName: invoices[0].cliente_nombre || 'Sin nombre',
        invoices,
        total,
      })
    }
  }
  return results.sort((a, b) => montoDistance(monto, a.total) - montoDistance(monto, b.total))
}
```

### 2. `src/lib/ai/voucher-pipeline.ts`

**a) Phase 1: agregar suma exacta antes de caer a no_match**

```typescript
// Después de matchVoucher, si no_match o ambiguous → try exact sum
if (amountMatch.status === 'no_match' || amountMatch.status === 'ambiguous') {
  const exactSums = findExactClientSumMatches(voucher.monto, amountCandidates)
  if (exactSums.length > 0) {
    if (exactSums.length === 1) {
      // validate name → multi_invoice
    } else {
      // multiple → ask user
    }
  } else {
    // fallback: findClientMatches con tolerancia
  }
}
```

**b) Phase 3: mostrar opciones enriquecidas**

```typescript
const clientesUnicos = new Set(candidates.map(c => c.cliente_nombre)).size
const mensaje = `Recibimos un pago de ${formatMonto(voucher.monto)}. ` +
  `Hay ${clientesUnicos} clientes posibles. ` +
  `Decinos el nombre exacto o el número de factura:\n\n` +
  opciones.join('\n')
```

### 3. `src/app/(dashboard)/voucher-debug/page.tsx`
- Mostrar el nuevo flujo: paso 1 (exacto), paso 2 (suma), paso 3 (cercanos)
- Indicar visualmente en qué paso se detuvo y por qué
- Mostrar validación de nombre (score, threshold)

## Edge cases

| # | Escenario | Status |
|---|-----------|--------|
| 1 | Pago parcial ($50 para factura de $100) | Ya existe |
| 2 | Pago > factura pero < factura+50 ($140 para $100) | Ya existe |
| 3 | Pago > factura+50 ($200 para $100) | Ya existe parcialmente |
| 4 | Match exacto contra 2 clientes diferentes ($1000 = MARIA y JUAN) | **Se arregla** |
| 5 | Match suma exacta + match individual ($200 = JUAN y $200 = MARIA $100+$100) | **No cubierto** |
| 6 | Sin nombre extraído por AI | Ya existe |
| 7 | Nombre AI incorrecto | **Se arregla** |
| 8 | Facturas mismo cliente mismo monto ($500+$500) | Ya existe |
| 9 | Monto > cualquier suma conocida ($9999) | Ya existe |
| 10 | 3+ facturas que suman exacto ($100+$200+$300=$600) | Ya existe |

## Prioridad

1. `voucher-matching.ts` — lógica de matching
2. `voucher-pipeline.ts` — integración
3. `voucher-debug/page.tsx` — UI actualizada
