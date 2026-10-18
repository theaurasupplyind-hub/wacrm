# Plan: Unificación del motor de ruteo del bot (webhook ↔ bot-beta)

> **Estado:** **parcialmente implementado (2026-10-12).** El motor de turno puro
> (`src/lib/bot/engine.ts`) y el adapter webhook están hechos (Fases 1-2 de este
> doc, ver "Estado de implementación"); además se agregó un planner LLM opt-in
> (Fases 3-5 del plan de turnos). **La migración de Bot Beta (Fases 3-4 de este
> doc) quedó FUERA DE ALCANCE** por decisión: se priorizó producción y no se
> tocó `src/lib/bot-beta/*`. El wrapper `runAssistantForWebhook` y el agente con
> tools ya existían.

## Estado de implementación (2026-10-12)

Plan de turnos ejecutado (ver `C:\Users\jesus\.opencode\plan\plan-motor-turnos-agente-planner.md`):

| Fase | Estado | Artefacto |
|---|---|---|
| 0 — red de seguridad | ✅ | `router.test.ts`, `engine.test.ts` (matriz de paridad + regresiones) |
| 1 — motor puro + adapter webhook | ✅ | `engine.ts`, `actions.ts`, `ports.ts`, `policy.ts`; `route.ts` adelgazado |
| 2 — adapter Bot Beta | ⛔ fuera de alcance | `unified-handler.ts` intacto (drift aceptado) |
| 3 — planner en sombra | ✅ | `planner.ts`, flag `ASSISTANT_AGENT_PLANNER=shadow` |
| 4 — planner por dominio | ✅ | `ASSISTANT_PLANNER_DOMAINS`, `reconcilePlans` |
| 5 — policy real (escrituras) | ✅ | `maxWritesPerTurn=1`, texto del usuario, `ASSISTANT_PLANNER_WRITES` |

Diferencia con el diseño original: el motor es una **función pura** (`planTurn`)
y el I/O lo hace el adapter (no hay ports con I/O todavía); `ports.ts` queda como
contratos para el futuro. Vouchers **congelados** (pass-through). Pending real:
idempotencia durable por `metaMessageId` (hoy por turno).

> **Objetivo:** converger los dos orquestadores que hoy rutean mensajes
> (`src/app/api/whatsapp/webhook/route.ts` y `src/lib/bot-beta/unified-handler.ts`)
> en un solo **motor de turno** transport-agnóstico, para que extracción,
> contextos multi-turn, clarify, voucher por texto, gastos, asistencia y
> asistente vivan en un único lugar y no se desincronicen.
>
> **Relación con otros planes:**
> - [`plan-bot-llm-unificado.md`](../archive/plan-bot-llm-unificado.md) — ya unificó la
>   **extracción** (un LLM → `UnifiedExtraction`). Este plan unifica la
>   **orquestación** alrededor del router.
> - [`plan-bot-beta-a-produccion-asistente.md`](../archive/plan-bot-beta-a-produccion-asistente.md)
>   — plan histórico, superado: el wrapper productivo ya existe. La unificación
>   descrita aquí sigue pendiente y debe preservar el agente/handlers actuales.
> - Contexto base: [`architecture.md`](../architecture.md) §6 (orden de dispatch),
>   [`resumen-bot-beta.md`](../archive/resumen-bot-beta.md).

---

## 1. Problema estructural

Hoy hay **dos pipelines que toman las mismas decisiones de ruteo** sobre el mismo
`decideDispatch` (`src/lib/bot/router.ts`), pero con orquestación duplicada:

| | Webhook (producción) | Bot Beta (dummy) |
|---|---|---|
| Entry | `processMessage` (`route.ts`, ~2130 líneas) | `runUnifiedBotBeta` (`bot-beta/unified-handler.ts`, ~472 líneas) |
| Contextos | `loadExpense/Attendance/Voucher/ClarifyContext` (Supabase real) | mismos loaders sobre conversación dummy `11999999999` |
| Extracción | `extractBotMessage` | `extractBotMessage` |
| Clarify | sí (ask + resolve) | **no existe** |
| Voucher texto | `processVoucherText` (prod pipeline) | forced-client/letter sobre **copia** `voucher-dryrun.ts` |
| Voucher imagen | `processVoucherMessage` | `runVoucherDryRun` |
| Asistente | `runAssistantForWebhook` (en `production.ts`) | `runAssistant` directo |
| Flows/Automations | sí (antes del motor) | no |

Consecuencias observadas:
1. **Drift de features**: clarify existe solo en prod; el arreglo reciente
   (`clarifyAnsweredIntent`, ver §6) no tiene equivalente en Beta.
2. **Duplicación copiada a mano**: `voucher-dryrun.ts` es una copia de
   `voucher-pipeline.ts` con el encabezado *"COPIADO … mantener sync manual si
   prod cambia"*. Todo fix de vouchers debe hacerse dos veces o queda desfasado.
3. **El bug voucher→gasto** nació de que la resolución de clarify vivía *dentro*
   del route, fuera del contrato extracción→router. Se corrigió con una señal
   de router (autoridad única), pero la orquestación sigue en dos lugares.
4. **Trazabilidad divergente**: `buildBotTrace`/`router_logs` se invocan distinto
   en cada pipeline.

La causa de fondo: **no existe una capa de orquestación única**; el router es
puro y compartido, pero quien lo alimenta y quien ejecuta sus efectos está
duplicado.

---

## 2. Diseño objetivo

### 2.1 Un motor de turno puro + puertos (ports & adapters)

```
                    ┌─────────────────────────────────────────┐
                    │  processInboundTurn(input, deps)         │
   entrada ───────► │  src/lib/bot/engine.ts                   │ ───────► TurnResult
   (texto/tap)      │  contexts → extractor → clarify →        │         (replies, writes,
                    │  decideDispatch → handler                │          dispatchedTo, trace)
                    └───────────────┬─────────────────────────┘
                                    │ ports (inyectados)
        ┌───────────────────────────┼────────────────────────────┐
        ▼                           ▼                            ▼
  ContextStorePort            SenderPort                   HandlerPorts
  (load/save/clear            (text/buttons/media)          (expense/attendance/
   expense/att/voucher/                                       voucher-text/assistant)
   clarify)                    → webhook adapter: Supabase real + engineSend*
                               → beta adapter: conversación dummy + dryRun
```

- **Motor** (`engine.ts`): decide y describe; no conoce Supabase ni WhatsApp.
  Devuelve `TurnResult` con los efectos a ejecutar (en vez de ejecutarlos
  inline), para que los adapters los materialicen y para poder testear sin I/O.
- **Router** (`router.ts`): se mantiene puro (ya lo es). El motor le pasa
  `clarifyAnsweredIntent`, `hasPending*`, `extraction`, `jevPending`.
- **Clarify**: pasa a ser un dominio del motor igual que expense/attendance/
  voucher (ask en un turno; resolve en el siguiente con `clarifyAnsweredIntent`).
- **Voucher**: un solo pipeline. `voucher-dryrun.ts` se elimina y la copia se
  reemplaza por el pipeline de producción con un flag `mode: 'commit' | 'dryRun'`.
- **Flows / Automations / media-voucher-imagen**: quedan **fuera** del motor,
  como gates pre-turno del adapter webhook (el motor arranca cuando hay texto o
  tap de bot relevante). Esto preserva la prioridad #1 de Flows.

### 2.2 Contratos (borrador)

```ts
// src/lib/bot/engine.ts
export interface TurnInput {
  text: string
  buttonId: string | null      // interactive_reply_id
  conversationId: string
  contactId: string
  accountId: string
  userId: string
  messageType: 'text' | 'interactive' | 'audio' | 'image' | 'document' | ...
  metaMessageId: string
}

export interface TurnDeps {
  contexts: ContextStorePort
  sender: SenderPort
  handlers: HandlerPorts
  telemetry: TelemetryPort
  now?: () => number
}

export interface TurnResult {
  dispatchedTo: string
  dispatchReason: string
  extraction: UnifiedExtraction | null
  // efectos ya resueltos, que el adapter materializa:
  actions: TurnAction[]
}

type TurnAction =
  | { kind: 'reply_text'; text: string }
  | { kind: 'reply_buttons'; body: string; options: ClarifyOption[] }
  | { kind: 'run_expense'; extraction: UnifiedExtraction | null }
  | { kind: 'run_attendance'; extraction: UnifiedExtraction | null }
  | { kind: 'run_voucher_text'; clientName: string; destName: string | null; metodoPago: 'Efectivo'|'Transferencia'; monto: number | null; fecha: string | null }
  | { kind: 'run_assistant'; text: string }
  | { kind: 'clear_context'; domain: 'expense'|'attendance'|'voucher'|'clarify' }
```

> El detalle de puertos se ajusta al implementar; el punto es que el motor no
> importe `supabaseAdmin`, `engineSend*` ni handlers concretos.

---

## 3. Fases de implementación

### Fase 0 — Red de seguridad (caracterización; rehacer sobre el estado actual)
- Tests de paridad que fijen las decisiones actuales: matriz
  `(intent, confianza, pendings, interactivo, clarify) → dispatchedTo/reason`.
  Reutilizar `router.test.ts` + casos nuevos.
- Snapshot de escenarios E2E conocidos (los de `plan-bot-llm-unificado.md` §Verificación
  y el caso voucher→gasto de §6) como tabla de regresión.
- Revalidar `lint`, typecheck y tests sobre la rama actual; el conteo de errores
  citado en el plan histórico de producción ya no es una referencia vigente.

### Fase 1 — Tipos y motor mínimo
- Crear `src/lib/bot/engine.ts` con `TurnInput`, `TurnResult`, `TurnAction`, `TurnDeps`.
- **Sin cambiar comportamiento**: mover la orquestación de texto de `route.ts`
  (contextos → `extractBotMessage` → clarify ask/resolve → `decideDispatch` →
  switch → acciones) a `engine.processInboundTurn`.
- `route.ts` queda como **adapter webhook**: arma `TurnInput`, llama al motor y
  materializa `actions` (envíos + `pushExpenseTask`/`pushAttendanceTask`/voucher/
  assistant). Flows, automations, media y template lifecycle siguen en el route.

### Fase 2 — Adapter webhook estable
- Extraer el bloque de contextos/extracción/clarify/voucher-text/fallback del route.
- Conservar exactamente el orden de gates (Flows #1 → interactive confirm →
  media voucher → extractor/motor → fan-out) y los `bgTasks`/`after()`.
- Tests: el motor produce el mismo `TurnResult` que la lógica previa para la
  matriz de Fase 0.

### Fase 3 — Migrar Bot Beta al motor
- `unified-handler.ts` pasa a: crear/obtener conversación dummy → llamar
  `processInboundTurn` con el **adapter beta** (`ContextStore` dummy, `Sender`
  no-op/collector, voucher `mode:'dryRun'`, assistant real).
- Gana **clarify** gratis (paridad con prod).
- Los forced-client/letter flows del dummy se reemplazan por el pipeline de
  voucher único en `dryRun`.

### Fase 4 — Eliminar duplicación de voucher
- Borrar `src/lib/bot-beta/voucher-dryrun.ts`.
- Parametrizar `src/lib/ai/voucher-pipeline.ts` con `mode: 'commit' | 'dryRun'`
  (ya hay trazas de dryRun en el pipeline). El adapter beta usa `dryRun`; prod
  usa `commit`.
- Test que verifica que `dryRun` nunca llama a `registrarPago`.

### Fase 5 — Cierre
- Actualizar `topology.ts` (nodos/aristas del motor único) y su test.
- Actualizar `architecture.md` §6 y `docs/bots/archive/resumen-bot-beta.md` (dejar de describir
  "el webhook real sigue con el pipeline legacy").
- Índice en `docs/bots/README.md`.

---

## 4. Archivos

| Archivo | Acción |
|---|---|
| `src/lib/bot/engine.ts` | **nuevo** — motor de turno + tipos/contratos |
| `src/lib/bot/ports.ts` | **nuevo** — `ContextStorePort`, `SenderPort`, `HandlerPorts`, `TelemetryPort` |
| `src/app/api/whatsapp/webhook/route.ts` | adelgazar a adapter; gates de Flows/automations/media se mantienen |
| `src/lib/bot-beta/unified-handler.ts` | pasa a adapter del motor; gana clarify |
| `src/lib/bot-beta/voucher-dryrun.ts` | **eliminar** (reemplazado por pipeline con `mode`) |
| `src/lib/ai/voucher-pipeline.ts` | flag `mode: 'commit' \| 'dryRun'` |
| `src/lib/bot/router.ts` | sin cambios de contrato (ya recibe `clarifyAnsweredIntent`) |
| `src/lib/bot-trace/topology.ts` | reflejar motor único |
| Tests (`src/lib/bot/*.test.ts`) | caracterización + paridad |
| `docs/bots/architecture.md`, `docs/bots/archive/resumen-bot-beta.md`, `docs/bots/README.md` | actualizar estado |

---

## 5. Riesgos y mitigaciones

- **Regresión por big-bang** → Fases incrementales con adapters; Fase 0 de
  caracterización fija el comportamiento actual antes de mover nada.
- **Orden de gates en el webhook** (Flows #1, interactive confirm, media) es
  delicado → el motor arranca *después* de esos gates; no se mueven.
- **`after()`/`bgTasks`**: los efectos deben seguir ejecutándose dentro de las
  promises que `after()` ve. El motor devuelve `actions`; el adapter las empuja
  a `bgTasks` como hoy.
- **Voucher `commit` vs `dryRun`**: el flag debe ser imposible de confundir;
  test explícito de que `dryRun` no escribe (`registrarPago` no se llama).
- **Alcance de config/flag**: no se toca el rollout del asistente (eso es del
  plan `plan-bot-beta-a-produccion-asistente.md`).
- **Rollback**: cada fase es un commit aditivo; revertir el commit de la fase
  vuelve al estado anterior sin migraciones de DB.

---

## 6. Estado de partida (ya corregido)

El bug `voucher → gasto` (tap "Me pagó (cobro)" ruteaba a expense) se corrigió
haciendo de clarify una autoridad de primera clase:
- `RouterState.clarifyAnsweredIntent` (`router.ts`) gana al fallback regex.
- `resolveClarifyExtraction` (`bot-llm/clarify-context.ts`) sintetiza la
  extracción en taps donde el extractor no corre.
- Arista `ctx_clarify → router` en la topología.

Ese cambio es la base sobre la que se apoya este plan: el motor único debe
preservar ese contrato (el router decide; el extractor es dato).

---

## 7. Verificación

- `npm run typecheck` · `npm run lint` (0 errores) · `npm run test` ·
  `npm run build`.
- **Paridad**: misma `TurnInput` + mismos contextos ⇒ mismo `dispatchedTo`/
  `dispatchReason` en adapter webhook y adapter beta (excepto lo documentado:
  dryRun vs commit).
- **E2E WhatsApp** (tabla de `plan-bot-llm-unificado.md` §Verificación):
  gastos, asistencia, vouchers, deuda, chitchat.
- **Caso regresión** §6: "Test pago 65 000 en efectivo" → tap "Me pagó (cobro)"
  ⇒ voucher (nunca "No detecté el monto").
- **Bot Beta**: mismo input en `/bot-beta` y en el webhook ⇒ misma decisión de
  ruteo (con voucher en dryRun).
