# Plan: de bots deterministas a un agente con propuestas (wacrm)

> **Estado:** propuesta para discusión. No implementado.
> **Fecha:** 2026-10-29.
> **Alcance:** bot interno de WhatsApp (Bastidores GAL) sobre `backend_gal`.
> **Fuera de alcance:** Flows visuales, AI Auto-Reply de cuentas, vouchers como
> pipeline de imagen (se mantiene congelado en este plan).
>
> Documentos relacionados:
> - [`../architecture.md`](../architecture.md)
> - [`../assistant-agent.md`](../assistant-agent.md)
> - [`../decisiones-y-gotchas.md`](../decisiones-y-gotchas.md)
> - [`plan-orquestador-llm-bots-rigidos.md`](./plan-orquestador-llm-bots-rigidos.md)

---

## 0. Problema

Hoy el sistema es un **router determinístico con un LLM en los bordes**:

1. Un extractor LLM clasifica intent y campos (`bot-llm/extract-bot-message.ts`).
2. `planTurn` decide por reglas y estados de dominio (`bot/engine.ts`).
3. Cada dominio tiene su handler y su parser (`expenses/`, `attendance/`,
   `vouchers`, `pedidos/`).
4. El agente con tools (`bot-assistant/agent.ts`) entra **solo** si el handler
   falla o si el usuario reintenta.
5. El planner LLM (`bot/planner.ts`) puede conducir por dominio, pero **no lee
   los argumentos** del modelo y por defecto no escribe.

Síntomas medibles:

- El mismo mensaje se interpreta tres veces (extractor → modelo → handler).
- El agente no puede resolver referencias ni componer una acción con campos.
- La continuidad depende de siete estados distintos; un follow-up se pierde si
  quedó en otro subsistema (incidente "Ale", `decisiones-y-gotchas.md` §13).
- Las confirmaciones no están atadas a la operación (ventana de 30 min por tool).
- No hay idempotencia durable por `metaMessageId`; Meta puede reprocesar.
- El system prompt contiene reglas de negocio, nombres y montos reales, y
  promete tools que no existen (`registrar_voucher`, `crear_presupuesto`).
- No hay memoria de hechos/preferencias ni historial visible para el usuario.

Objetivo: que el LLM **componga la propuesta** (qué acción y con qué datos) y que
los guards **verifiquen** antes de ejecutar. El determinístico deja de ser el
dueño del turno y pasa a ser ejecutor/validador.

---

## 1. Objetivos y no-objetivos

### Objetivos

1. Un único estado de conversación y un único contrato de propuesta
   (`PendingAction`) para todos los dominios.
2. Tools con **argumentos estructurados** (no texto crudo), validadas con Zod.
3. Agente al frente para texto libre, con rollout por dominio y posibilidad de
   volver al determinístico sin deploy.
4. Idempotencia durable y ledger de escrituras para todos los caminos.
5. Memoria explícita (hechos/preferencias/correcciones) + resumen de conversación.
6. Historial de turnos visible (tools, args, mutaciones, tokens) y undo.
7. Reducir los prompts a instrucciones y políticas; sacar reglas de negocio.

### No-objetivos (por ahora)

- Dar autonomía total sobre dinero. Las escrituras de plata siguen confirmándose
  (con opt-in por usuario para autosaves ya conocidos, ver §7).
- Reemplazar vouchers por imagen: se mantienen congelados.
- Unificar AI Auto-Reply con el asistente (se resuelve en Fase 6).
- Multi-acción en un solo turno más allá de lo que permita la policy.

---

## 2. Principios de diseño

1. **El agente propone, el runtime dispone.** Ningún tool call ejecuta una
   escritura sin pasar por `authorizeProposal`.
2. **Una propuesta = un id.** `PendingAction.id` viaja en la confirmación; no se
   confirma por ventana de tiempo ni por nombre de tool.
3. **Estado único.** `conversation_state` + `pending_actions` + `agent_memory`.
   Los contextos por dominio se migran; no se agregan nuevos.
4. **El texto original es evidencia, no comando.** El modelo compone args; los
   args se validan contra el estado real antes de ejecutar.
5. **Reversible automático, irreversible confirmado.** Leer = siempre; asistencia
   = auto si hay match fuerte; dinero/borrar = confirmación; vouchers = fuera.
6. **Todo turno se audita.** `agent_turns` con plan, tools, args, resultado,
   tokens y latencia; `write_ledger` para cualquier escritura.
7. **Volver atrás es un flag.** Cada fase deja el camino viejo operativo.

---

## 3. Arquitectura target

```
WhatsApp webhook
  └─ persistir + dedupe por metaMessageId
  └─ cargar ConversationState (resumen + últimos N + pending + memoria)
  └─ AGENTE (loop de tools)
       ├─ tools de lectura  → backend_gal (ejecutan ya)
       ├─ tools de escritura → NO ejecutan: devuelven Proposal
       └─ texto de respuesta
  └─ authorizeProposal(proposal, state, policy)
       ├─ allow  → ejecutar (idempotente) + write_ledger
       ├─ confirm → guardar pending_action + reply con confirmación
       └─ deny   → reply explicando / pedir dato
  └─ enviar respuesta + confirmación
  └─ registrar agent_turn
```

El webhook queda como **adapter**: persistencia, dedupe, carga de estado, envío y
`after()`; no decide negocio.

### Contrato de propuesta

```ts
export type ProposalDomain =
  | 'expense' | 'attendance' | 'voucher' | 'order' | 'assistant'

export interface Proposal {
  id: string                    // uuid, generado por el runtime
  domain: ProposalDomain
  tool: string
  args: Record<string, unknown> // validados por Zod
  summary: string               // texto para el usuario
  effect: 'read' | 'write' | 'destructive'
  sourceMessageId: string
  createdAt: string
  expiresAt: string             // TTL por dominio
}
```

`PendingAction` = `Proposal` persistida con `status`
(`pending|confirmed|cancelled|superseded|expired`) y `confirmed_at`.

---

## 4. Fases

Cada fase es desplegable y reversible por flag. Los tiempos son estimaciones de
trabajo, no compromisos.

### Fase 0 — Baseline y red de seguridad (1–2 días)

**Objetivo:** medir antes de cambiar.

- `scripts/agent-baseline.mjs`: lee `router_logs`/`bot_traces` de los últimos 30
  días y calcula: turnos sin respuesta (`none`/`no_reply`), `replied_dead_end`,
  escrituras por turno, confirmaciones, correcciones posteriores, latencia p50/p95
  y costo estimado.
- `test/agent/golden/*.json`: 40–60 conversaciones multi-turno con efecto
  esperado (gasto, asistencia, voucher, pedido, consulta, corrección).
- `scripts/agent-eval.mjs`: corre el golden set contra el sistema actual y
  guarda un reporte versionado (`baseline-v0.json`).
- Criterio: ninguna fase siguiente se aprueba sin comparar contra este baseline.

**Archivos:** `scripts/agent-baseline.mjs`, `scripts/agent-eval.mjs`,
`test/agent/golden/`, `docs/bots/plans/baseline-v0.json` (artefacto).

---

### Fase 1 — Estado único, idempotencia y ledger (3–5 días)

**Objetivo:** una sola fuente de estado y una sola escritura por mensaje.

#### Migraciones

- `057_conversation_state.sql`
  - `conversations.state jsonb not null default '{}'`
  - shape:
    ```json
    {
      "phase": "idle|awaiting_action|awaiting_slot|processing",
      "active_domain": "expense|attendance|voucher|order|assistant|null",
      "summary": "string (resumen acumulado)",
      "last_turn": { "message_id": "...", "outcome": "...", "at": "..." },
      "pending_action_id": "uuid|null"
    }
    ```
- `058_pending_actions.sql`
  - `id uuid pk`, `conversation_id`, `contact_id`, `account_id`
  - `domain`, `tool`, `args jsonb`, `summary`, `effect`
  - `status`, `source_message_id`, `created_at`, `expires_at`, `confirmed_at`
  - índice único parcial: una sola `pending` por conversación.
- `059_processed_messages.sql`
  - `meta_message_id text unique`, `conversation_id`, `processed_at`
  - el webhook hace `insert ... on conflict do nothing`; si no inserta, **no
    procesa** (idempotencia durable).
- `060_write_ledger.sql`
  - generaliza `bot_write_log` para voucher/pedidos/asistencia:
    `id, account_id, conversation_id, domain, tool, entity, entity_id, args,
    result, source_message_id, created_at, undone_at`
  - `bot_write_log` se mantiene como vista/compatibilidad durante la transición.

#### Código

- `src/lib/bot/state.ts` (nuevo): `loadConversationState`,
  `saveConversationState`, `mergeState`, `clearDomain`.
- `src/lib/bot/pending-actions.ts` (nuevo): CRUD y `resolvePendingAction`
  (confirm/cancel/correct).
- `src/lib/bot/idempotency.ts` (nuevo): `claimMessage(metaMessageId)`.
- `src/app/api/whatsapp/webhook/route.ts`: al inicio del `after()`, reclamar el
  mensaje; si ya existe, salir. Leer/escribir `conversations.state` en lugar de
  los 7 contextos.
- `src/lib/bot/engine.ts`: `planTurn` acepta `state` y `pendingAction`; los
  contextos viejos se leen solo si `state` está vacío (compatibilidad).
- `src/lib/bot-assistant/pending-confirm.ts`: se reemplaza por
  `pending-actions.ts`; se elimina `hasRecentConfirmation` y el bypass
  `_confirmed`.

#### Compatibilidad

- Durante la fase, escribir **también** los contextos viejos (dual-write) para
  permitir rollback. Leer del nuevo; si falta, caer al viejo.
- No borrar columnas viejas hasta Fase 6.

**Criterio de salida:** el golden set pasa por igual; dos entregas del mismo
`metaMessageId` producen una sola escritura; un follow-up de voucher funciona sin
depender de `voucher_awaiting_match`.

---

### Fase 2 — Tools con argumentos estructurados (3–4 días)

**Objetivo:** que el modelo componga la acción; que el handler deje de re-parsear.

- `src/lib/bot-assistant/tool-registry.ts`:
  - Cada tool declara `parameters` Zod (schema real) y `returns` Zod.
  - `execute` valida con Zod y **no** acepta texto crudo como sustituto de campos.
  - Las tools de escritura devuelven `Proposal` (no ejecutan).
- Nuevo `src/lib/bot-assistant/services/`:
  - `expenses.ts`: `createExpense(args)` (sin parser; recibe monto, categoría,
    proveedor/empleado, método, fecha, descripción).
  - `attendance.ts`: `upsertAttendance(args)`.
  - `orders.ts`: `quoteOrder(args)`, `createOrder(args)` (detrás de confirmación).
  - `vouchers.ts`: se mantiene separado; solo lectura de estado.
- Los parsers (`expenses/parse-expense.ts`, `attendance/parse-attendance.ts`,
  `pedidos/`) quedan como **fallback** para el camino determinístico y como
  compatibilidad, pero el agente no los usa.
- El extractor pasa a ser **hint opcional** (flag `EXTRACTOR_HINTS=shadow|on`),
  no la fuente de args.
- `texto_crudo` se guarda en `args._raw` solo para auditoría.

**Contrato de ejemplo:**

```ts
registrar_gasto({
  monto: number (>0),
  moneda?: 'ARS',
  categoria?: string,
  proveedor?: string,
  empleado?: string,
  metodo?: 'efectivo' | 'transferencia' | 'debito' | 'credito',
  fecha?: 'YYYY-MM-DD',
  descripcion?: string,
  comprobante?: { tipo: 'imagen'|'pdf', ref: string }
})
```

**Criterio de salida:** `registrar_gasto` con args completos crea **una** fila con
esos valores; no vuelve a parsear; el test verifica monto/categoría/fecha exactos.

---

### Fase 3 — Agente al frente, por dominio (5–7 días)

**Objetivo:** que el agente conduzca el turno de texto libre, con guards.

#### Flags

| Env | Valores | Default |
|---|---|---|
| `ASSISTANT_ORCHESTRATOR` | `off \| shadow \| on` | `off` |
| `ORCHESTRATOR_DOMAINS` | csv `expense,attendance,order,assistant` | vacío |
| `ORCHESTRATOR_WRITES` | `none \| confirm \| auto` | `confirm` |
| `ORCHESTRATOR_MAX_ITERS` | 1–6 | `4` |
| `ORCHESTRATOR_MODEL` | modelo | `ASSISTANT_MODEL` |

- `shadow`: el agente corre y se registra la propuesta; ejecuta el determinístico.
- `on` + dominio habilitado: el agente conduce; los guards pueden vetar y caer al
  determinístico.

#### Flujo del turno

1. Si hay `pending_action` y el mensaje es confirmación/cancelación/corrección:
   resolver **antes** del loop (sin invocar al modelo para un "sí").
2. Si hay humano asignado, voucher o un pending de dinero → no takeover.
3. Agente con tools: lecturas directas; escrituras devuelven `Proposal`.
4. `authorizeProposal` evalúa:
   - dominio habilitado y tool permitida;
   - `effect` y monto (límites por usuario/config);
   - `pending_action` existente (no dos a la vez);
   - `ORCHESTRATOR_WRITES`: `none` deniega, `confirm` guarda pending, `auto`
     ejecuta solo si `effect !== 'destructive'` y confianza alta;
   - vouchers congelados.
5. Ejecutar o guardar pending; responder; registrar turno.

#### Rollout

`shadow` 3–5 días → `on` + `assistant` (solo lectura) → `+expense` con
`ORCHESTRATOR_WRITES=confirm` → `+attendance` (auto si match fuerte) → `+order`
(cotizar; crear siempre confirmado).

**Criterio de salida:** en el golden set, el agente iguala o mejora la tasa de
resolución y **no** aumenta escrituras duplicadas, dead-ends ni latencia p95 > 6 s.

---

### Fase 4 — Memoria, resumen y prompts cortos (3–4 días)

- `061_agent_memory.sql`
  - `id, account_id, contact_id|null, category
    (correction|preference|context|fact), content, source_message_id,
    created_at, last_used_at, expires_at|null`
  - índice por `(account_id, contact_id, category)`.
- `062_conversation_summary.sql` (o `state.summary` si alcanza)
  - resumen incremental por conversación con `updated_at` y `tokens`.
- `src/lib/bot-assistant/memory.ts`: `retrieveMemory` (top-k por relevancia
  simple: categoría + recencia + keywords), `writeMemory` (solo desde
  correcciones explícitas o confirmaciones), `forgetMemory`.
- `src/lib/bot-assistant/summary.ts`: resumen cada N turnos o al cerrar tema,
  con tope de tokens.
- `prompts.ts`: bajar a instrucciones + tono + política. Sacar:
  - nombres/montos de clientes;
  - reglas de flujo ("solo tras un sí");
  - claves de tools inexistentes;
  - reglas que ya viven en Zod o en `authorizeProposal`.
- El prompt del turno pasa a:
  `[system corto] + [memoria] + [resumen] + [últimos 8–10 mensajes] + [estado] + [mensaje]`.

**Criterio de salida:** una corrección ("ojo, no era luz, era gas") se guarda como
`correction` si el usuario confirma; el turno siguiente la usa sin que el usuario
repita. Prompt del sistema < 1.500 tokens.

---

### Fase 5 — Observabilidad de usuario y undo (2–3 días)

- `063_agent_turns.sql`
  - `message_id, conversation_id, model, prompt_version, plan jsonb,
    tool_calls jsonb, proposals jsonb, writes jsonb, tokens, latency_ms,
    outcome, created_at`
- `src/app/(dashboard)/conversations/[id]/agent-tab.tsx`:
  - lista de turnos con tools/args/resultado;
  - “qué se envió al modelo” (sin secretos);
  - estado de la propuesta y su resultado.
- `undo` desde el historial: usa `write_ledger` (24 h), muestra qué se deshace.
- Medidor de capacidad/costos si se adopta el modelo de cupo.

**Criterio de salida:** un operador puede explicar por qué el bot hizo X sin abrir
`router_logs`, y deshacer una escritura desde la UI.

---

### Fase 6 — Limpieza y consolidación (2 días)

- Borrar `bot/pending-confirm.ts`, `hasRecentConfirmation`, `_confirmed`.
- Borrar los 7 contextos viejos y sus columnas (después de 2 semanas sin uso).
- Eliminar `planner.ts` como loop separado: el orquestador ya planifica.
- Eliminar el prompt gigante del extractor o dejarlo solo como hint `shadow`.
- Resolver el doble asistente: si el agente no produce texto, **no** llamar a
  `AI Auto-Reply` en la misma conversación; enviar un mensaje de fallback del
  propio agente o dejar que un humano tome.
- Actualizar `docs/bots/*` y archivar este plan.

---

## 5. Modelo de datos (resumen)

| Tabla/columna | Uso | Fase |
|---|---|---|
| `conversations.state` | phase, domain, summary, last_turn, pending id | 1 |
| `pending_actions` | propuesta + confirmación atada a id | 1 |
| `processed_messages` | idempotencia por `metaMessageId` | 1 |
| `write_ledger` | auditoría/undo de toda escritura | 1 |
| `agent_memory` | hechos/preferencias/correcciones | 4 |
| `conversation_summary` | resumen incremental | 4 |
| `agent_turns` | historial visible + eval | 5 |

`bot_write_log`, `bot_pending_confirms`, `clarify_context`, `expense_context`,
`attendance_context`, `voucher_context`, `voucher_awaiting_match`,
`order_context`, `bot_last_turn` quedan **read-only** durante la transición y se
eliminan en Fase 6.

---

## 6. Guards y política (orden exacto)

Antes de ejecutar cualquier propuesta:

1. `claimMessage(metaMessageId)` — si ya procesado, cortar.
2. Humano asignado → no responder (o notificar).
3. `pending_action` vigente:
   - confirm/cancel → ejecutar/cerrar;
   - corrección (nuevo contenido) → **no** descartar: re-planificar con el
     pending como contexto (fix del bug actual de "superseded").
4. Propuesta del agente.
5. `authorizeProposal`:
   - tool conocida y dominio habilitado;
   - `effect=destructive` → siempre `confirm`;
   - `effect=write` → según `ORCHESTRATOR_WRITES` y límites;
   - una sola pending por conversación;
   - vouchers: denegado (sigue su pipeline);
   - args Zod válidos y entidades existentes (IDs frescos, nunca del historial).
6. Ejecutar con `source_message_id` + `pending_id` en `write_ledger`.
7. Registrar turno y responder.

Invariantes:

- Nunca afirmar “registrado” sin `write_ledger` de esa propuesta.
- Nunca tomar un ID/monto del historial para una escritura; se resuelve con tools.
- Nunca ejecutar dos veces la misma propuesta (unique por `pending_id`).
- Cancelar una propuesta **no** borra estado de dominio (fix del incidente
  “no” borró `order_context`).

---

## 7. Autonomía propuesta

| Operación | Default | Opt-in |
|---|---|---|
| Lecturas | auto | — |
| Asistencia con match fuerte | confirm | auto por cuenta |
| Gasto ≤ límite y sin ambigüedad | confirm | auto por cuenta |
| Gasto > límite / nuevo proveedor | confirm | siempre |
| Pedido (cotizar) | auto (preview) | — |
| Pedido (crear) | confirm | nunca auto al inicio |
| Voucher | fuera del agente | — |
| Borrar/editar | confirm | nunca auto |

El límite de gasto y el opt-in viven en `ai_configs` (no en env) para que el
dueño los cambie sin deploy.

---

## 8. Tests y evaluación

- **Unit:** Zod de cada tool, `authorizeProposal`, `pending_actions`,
  `claimMessage`, política de autonomía.
- **Integración:** webhook con Supabase local; doble entrega del mismo
  `metaMessageId`; confirmación con id; corrección de un pending; voucher no
  tomado por el agente.
- **Golden set:** 40–60 conversaciones multi-turno con efectos; correr antes y
  después de cada fase. Métricas: resolución, escrituras, duplicados, dead-ends,
  latencia p50/p95, tokens/costo.
- **Live eval:** mantener `agente-eval.live` para extractor y agregar
  `orchestrator-eval.live` con el modelo elegido.
- **CI:** ningún test nuevo depende de red; los live quedan marcados y fuera del
  pipeline.

---

## 9. Criterios de aceptación (por fase)

- **F1:** mismo golden set; 0 duplicados con doble webhook; follow-up de voucher
  resuelto; rollback por flag sin migrar datos.
- **F2:** tools con args exactos; no re-parseo; tests de contrato.
- **F3:** `shadow` sin cambios de comportamiento; `on` con ≤ baseline de
  dead-ends y duplicados; p95 no peor que +20 %.
- **F4:** corrección recordada; prompt < 1.500 tokens; resumen no pierde el
  pending.
- **F5:** historial visible y undo de una escritura.
- **F6:** sin referencias a contextos viejos; docs actualizados.

---

## 10. Riesgos y mitigación

| Riesgo | Mitigación |
|---|---|
| El agente inventa args | Zod + entidades frescas + `authorizeProposal` |
| Doble escritura | `processed_messages` + unique por `pending_id` + ledger |
| Pérdida de continuidad al migrar | dual-write y lectura con fallback a contextos viejos |
| Latencia mayor (loop) | max 3–4 iteraciones; lecturas en paralelo; modelo por dominio |
| Costo | baseline + cupo; cache de prompt estable (resumen al inicio) |
| Vouchers rompen | congelados; el agente no los toca |
| El usuario no confía | historial visible + undo + mensajes que explican qué falta |
| Rollback | flags por fase; columnas viejas intactas hasta F6 |

---

## 11. Preguntas para discutir

1. **Modelo del orquestador:** ¿seguimos con Gemini Flash Lite o probamos uno más
   fuerte solo para el turno (con p95 objetivo)? El piloto DeepSeek se descartó
   por latencia; el “feel” de stepbro puede venir del modelo.
2. **Escrituras de dinero:** ¿empezamos con `confirm` para todo (recomendado) o
   habilitamos auto para gastos chicos desde el día uno?
3. **Multi-acción:** ¿permitimos dos propuestas en un turno (“50k a Juan y 20k a
   Pedro”) con confirmación por lote, o seguimos con una?
4. **Extractor:** ¿lo dejamos como hint `shadow` para comparar o lo apagamos
   cuando el agente esté `on`?
5. **Vouchers:** ¿los dejamos fuera indefinidamente o exponemos solo lectura
   (`consultar_vouchers_pendientes`) en Fase 5?
6. **UI:** ¿el historial va en la conversación existente o en una pestaña
   “Agente” separada?
7. **Migración de estados:** ¿migramos los JSON existentes a `state` o esperamos
   a que expiren (TTL ≤ 15 min) y arrancamos limpio?

---

## 12. Orden de trabajo sugerido

1. F0 baseline (sin tocar producción).
2. F1 estado + idempotencia + ledger (detrás de `STATE_V2`).
3. F2 tools v2 (compatibles con el agente actual).
4. F3 orquestador `shadow` → `on` por dominio.
5. F4 memoria + prompt corto.
6. F5 historial + undo.
7. F6 limpieza.

Cada fase termina con: golden set, reporte de métricas, doc actualizado y flag de
rollback probado.
