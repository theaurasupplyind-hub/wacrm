# Definición de "ambiguo" — gate de auto-save vs confirmación

> Fase 0 del plan agente-conversacional. Regla madre: **todo se auto-guarda,
> salvo lectura ambigua → se pide confirmación**. Este doc define "ambiguo" por
> escrito para que el gate de la Fase 2 sea implementable y el eval de la Fase 0
> sea medible. Fuente de umbrales numéricos: `src/lib/bot-llm/confidence.ts`
> (alta ≥ 0.75, media ≥ 0.45) y `src/lib/expenses/fuzzy-match.ts` (match ≥ 0.6).

## Principio

Ambigüedad no es "el parser duda": es **cualquiera de estas dos situaciones**:

1. **No sé qué quisiste decir** (ambigüedad de intención): dos o más
   interpretaciones plausibles y ninguna domina.
2. **Sé qué quisiste decir pero me falta o me tiembla un dato** (ambigüedad de
   datos): falta un campo obligatorio, o un match de entidad es débil, o la
   entidad/categoría es nueva.

## Señales y umbrales

| # | Señal | Ambiguo si… | Dónde vive hoy |
|---|---|---|---|
| S1 | Confianza del LLM | `confianza === 'baja'` o `dudoso === true` | `types.ts`, `confidence.ts` |
| S2 | Banda de pago pelada | `classifyPaymentIntent(texto) === 'ambiguous'` (ej. "Jo pago", sin verbo claro ni contexto) | `ambiguity.ts:47`, `payment-intent.ts` |
| S3 | Match de entidad débil | mejor score fuzzy < 0.6, **o** gap entre top1 y top2 < 0.15 (empate entre proveedor/empleado/producto/cliente) | `fuzzy-match.ts:209,290` (umbral 0.6; el gap es nuevo, Fase 2) |
| S4 | Entidad o categoría nueva | el nombre no matchea nada existente (implica crear proveedor/empleado/categoría/producto/cliente) | `fuzzy-match.ts`, handlers |
| S5 | Campo obligatorio faltante | gasto sin monto; asistencia sin empleado ni hora resoluble; pedido sin items/medidas; voucher sin monto ni candidato | `types.ts: MissingField`, handlers |
| S6 | Confianza media en operación irreversible | `confianza === 'media'` + operación ∈ {factura/presupuesto, registrar pago} | nuevo, Fase 2 |

## Regla de decisión

```
SI S2 (banda pago) → CONFIRMA (cobro vs gasto), siempre.
SINO SI S1 con 2+ hipótesis concretas → CONFIRMA con opciones (clarify).
SINO SI S3 o S4 o S5 → CONFIRMA con el dato puntual ("¿el proveedor es X?",
  "¿a qué empleado?", "¿qué monto?").
SINO SI S6 → CONFIRMA (vara estricta en irreversible).
SINO → AUTO-SAVE.
```

Casos que **nunca** son ambiguos (van directo): saludos/chitchat (`otro`),
consultas de lectura con datos suficientes, asistencia completa con empleado
conocido, gasto completo con todo conocido y confianza alta.

## Vara estricta en operaciones irreversibles (acordado)

La regla es la misma para todo, pero la vara de "ambiguo" es más baja para
**crear presupuesto/factura** y **registrar pago**: ante la duda se confirma.
Un gasto mal cargado se deshace en 1 click dentro de 24h (Fase 2, undo);
un documento o un pago mal imputado cuesta más. Ver `architecture.md` §6.

## Relación con el código actual

- `detectAmbiguity` (`ambiguity.ts`) ya cubre S2 y parte de S1 → se reutiliza,
  no se reescribe.
- `isExpenseAmbiguous` (monto dudoso, categoría nueva, sin match) cubre parte
  de S3–S5 para gastos → generalizado en el gate (`effect-gate.ts`).
- Vouchers por texto: el nombre usa `NAME_MATCH_THRESHOLD = 0.5` (score del
  backend) y `isNameMatch` local; un match débil, sin nombre o transferencia se
  confirma (S5/S6). El fuzzy de clientes (Jaro-Winkler) solo sugiere y nunca
  auto-guarda. Ver `vouchers.md` → "Voucher por texto".
- S3 se alimenta del pre-match único del agente (`deriveMatchInfo` sobre
  `entityScores` del fuzzy, Fase 4); S6 rige en el gate desde Fase 2.
- Los umbrales numéricos viven en `confidence.ts` (fuente única).

## Medición (Fase 0)

El dataset `AGENTE_FIXTURES` (`src/lib/bot-llm/agente-fixtures.ts`) etiqueta
cada caso con `behavior: 'auto' | 'confirma'` según esta definición. El eval
live (`agente-eval.live.test.ts`) reporta intent accuracy y distribución
auto/confirma. Desde Fase 4 el gate exige de verdad en la vía del agente
(auto-save o pendiente de confirmación con `bot_pending_confirms`).
