# Plan: LLM orquestador + bots rígidos (estado fresco)

> **Estado:** Fases 1-7 implementadas (soft-cancel, ruteo sticky, intérprete
> general, `unsupported`, estado fresco, delegación determinística, guard G3 y
> prompt de grounding). Fase 8 (planner `on` por dominio) queda como rollout.
> **Origen:** incidente real del 15/10/2026 (conversación `05fe8f78…`) + iteración
> de diseño. Evidencia en `router_logs` / `bot_traces`.
> **Para:** el agente ejecutor. TypeScript strict, sin comentarios innecesarios,
> seguir los patrones de `src/lib/expenses/` y `src/lib/pedidos/`. Antes de tocar
> rutas/componentes de Next, leer `node_modules/next/dist/docs/` (Next 16 tiene
> breaking changes).
> **No ejecutar la sección "Fuera de alcance".**

## 1. Objetivo

Que el bot pueda resolver **cualquier** mensaje sobre un pedido/presupuesto —aunque
no esté previsto— sin sumar keywords ni pasos: el **LLM orquesta con estado fresco
de los bots**, los **bots rígidos ejecutan y confirman**, y el orquestador **nunca
afirma** una acción que ningún bot hizo.

## 2. Diagnóstico (evidencia, 15/10/2026)

Dos fallas distintas, misma raíz: cuando el mensaje se sale del camino programado,
nadie lo resuelve; o se descarta en silencio, o lo agarra el asistente y lo inventa.

**A — cambio no previsto que se descarta.** `interpret-modification.ts:22` solo
entiende 3 operaciones (`discount_percent`, `remove`, `set_quantity`). Un cambio de
precio ("cambiale el precio al bastidor de 142 x 195 a 300mil", `router_logs id=414`)
devuelve `null` → cae en `presentQuote` (`index.ts:1146`), que re-parsea
`quoteText + texto` y **re-muestra el mismo bloque**: el cambio se pierde sin aviso.
(Un cambio de variante —"todos sin tela", `id=415`— sí resolvió bien: ese es el
comportamiento correcto a generalizar.)

**B — la conversación se cae del flujo al asistente.** Secuencia real:
```
22:17 id=421 "tapiz 39 x 78, tapacanto 78 x 67, y un rollo de tela" → pedido ✅ (cotización)
22:17 id=422 "no"                        → pedido → CANCELA y BORRA order_context
22:20 id=423 "perdon, si quiero que llo hagas presupuesto" → intent=otro → ASSISTANT ❌
22:21 id=424 "el cliente es Federico, es envio"            → otro → ASSISTANT ❌
22:22 id=426 "si pero el cliente no es nuevo…"             → otro → ASSISTANT ❌
```
- `"no"` **borra** el `order_context` (`index.ts:1087`): la cotización solo vive en
  el historial de chat.
- `"hagás presupuesto"` lo clasifica el extractor como `otro`, y
  `isExplicitBudgetCreationRequest` (`intent.ts:2`) **no matchea "hagas"**.
- El asistente **inventó estado**: el texto *"Voy a armar este presupuesto… Cliente
  nuevo: Pachecho / Entrega: Retira / Fecha 16/10… ¿Confirmás?"* **no lo produjo
  ninguna tool** (`cotizar_pedido` usa `previewPedido`, que dice *"Cotización
  estimada:"* con `confirm:false`, `preview.ts:65`). El LLM copió el formato del
  flujo y metió "Pachecho" del pedido anterior de la misma conversación
  (`id=417/418`). De ahí los candidatos de César para "Federico".

## 3. Principios rectores (acordados)

1. **El LLM orquesta; los bots ejecutan.** El orquestador decide, pero la
   ejecución y la confirmación son de los handlers determinísticos.
2. **Estado fresco, nunca del historial.** El orquestador consulta el estado real a
   los bots; el chat es contexto, no fuente de verdad.
3. **Re-llamar, no improvisar.** Si un mensaje cae al orquestador y pertenece a un
   dominio con estado, el orquestador **invoca el bot** de ese dominio.
4. **Nunca afirmar lo que no se hizo.** Sin resultado real de un bot (con
   `handled:true` / escritura confirmada), el orquestador no dice "creé", "guardé",
   ni emite el formato de estado del flujo.
5. **Intérprete general.** El LLM traduce el mensaje a **operaciones tipadas** sobre
   el estado; el bot las aplica determinísticamente. Si no hay operación → no puede,
   lo dice y ofrece continuar.

## 4. Arquitectura en capas

```
Capa 1  ORQUESTADOR (LLM)                  bot-assistant/agent.ts + planner.ts
            │  lee estado fresco (read-only)         │  propone acciones
            ▼                                        ▼
Capa 2  ESTADO FRESCO (tools de lectura)      contracto nuevo (get_*_state)
            │
            ▼
Capa 3  BOTS RÍGIDOS (handlers determinísticos)  pedidos/ · expenses/ · attendance/ · voucher
            │  validan · confirman · ejecutan · responden
            ▼
Capa 4  INTÉRPRETE GENERAL (LLM → ops tipadas)   usada POR el bot de pedidos
            │
            ▼
Capa 5  LEDGER DE ESCRITURAS                 bot_write_log (undo 24h + "qué se hizo")
```

El **planner LLM (Fases 3-5, `bot/planner.ts` + `reconcilePlans` + `policy.ts`) ya
es este orquestador**. Falta: (a) darle estado fresco de los bots; (b) que sus
acciones **deleguen** en los bots rígidos en vez de narrar.

## 5. Contratos nuevos

### 5.1 Estado fresco (tools de lectura que exponen los bots)

- `getOrderState(conversationId)` → `{ open, resumable, items, total, clienteNombre,
  clienteCandidatos, tipoEntrega, fechaEntrega, descuento, awaiting* }`.
- `getPendingConfirms(conversationId)` y `getLastWrite(conversationId)` (ya existen en
  `bot_pending_confirms` / `bot_write_log`).

El orquestador **siempre** los lee antes de responder. Prohibido reconstruir estado
desde el historial.

### 5.2 Operaciones tipadas (intérprete general, para el bot de pedidos)

Entrada: `{ estadoFresco, mensaje, historialReciente }` (el estado lo inyecta el bot,
no el LLM). Salida: lista de operaciones + `none` | `unsupported{motivo, ofrecido}`.

| op | efecto (determinístico) |
|---|---|
| `resume` / `cancel` / `confirm` | reanudar cotización cancelada / cancelar / confirmar y ejecutar |
| `set_quantity{line,n}` · `remove{line}` · `add{items}` | reusan `applyQuoteModification` |
| `set_price{line, mode:absolute\|percent, value}` | **nuevo** (precio directo) |
| `set_variant{line, variant}` · `set_measure{line, medida}` | **nuevo** (re-resuelve contra catálogo) |
| `set_discount{...}` | montos/% |
| `set_client{name}` · `set_delivery{tipo}` · `set_date{fecha}` · `set_address{dom}` | slots de entrega |
| `unsupported{motivo}` | responder honesto + ofrecer continuar |

Aplicación: **solo el bot** (nunca el LLM calcula precios). El intérprete reemplaza
`interpret-modification.ts`.

## 6. Reglas duras (guards)

- **G1 (sticky):** con `order_context` presente —abierto **o** cancelado-reanudable—
  el dispatch va a `pedido`. Cancelar deja de borrar: marca `quoteCancelled` y conserva
  items/`quoteText` (TTL ya existe: `QUOTE_TTL_MS` / `STALE_QUOTE_RECALL_MS`).
- **G2 (delegación):** el orquestador no ejecuta escrituras por su cuenta; propone y
  el runtime delega en el bot. Sin `handled:true` del bot, no hay afirmación.
- **G3 (no-formato):** el orquestador tiene prohibido emitir los literales del flujo
  (`"Voy a armar este presupuesto:"`, `"Cliente nuevo:"`, `"Cotización estimada:"`,
  `"¿Confirmás?"`, `"Presupuesto P-…"`). Guard de salida + test.
- **G4 (cliente):** el cliente sale **solo** de `searchCandidates(nombreDelMensaje)`
  (`index.ts:276`), nunca del historial ni del LLM.
- **G5 (anti-repetición):** si el mensaje no cambia el estado, **no** re-mostrar el
  mismo bloque: responder "no pude aplicar X" con lo que entendió.
- **G6 (idempotencia):** la delegación registra en `bot_write_log`; doble ejecución
  del mismo mensaje no duplica.

## 7. Flujo de un mensaje (después)

```
webhook → extractor
  → ¿háya dominio abierto/reanudable o intent claro?  ── sí → BOT RÍGIDO (sticky, G1)
  → no → ORQUESTADOR (LLM)
         → getOrderState/getPendingConfirms/getLastWrite   (estado fresco)
         → ¿el mensaje pertenece a un dominio?  ── sí → invoca ese BOT (G2)
         → ¿operación no soportada?              → "no puedo, ¿seguimos?" (op unsupported)
         → si no → responde/cotiza/consulta con los datos reales (G3)
  → el bot ejecuta/confirma y responde; recién ahí hay afirmación
```

## 8. Fases

| # | Entregable | Archivos | Esf. |
|---|---|---|---|
| 0 | Fixtures de los 2 incidentes (regresión) | `pedidos/index.test.ts`, `bot-llm/agente-fixtures.ts` | S |
| 1 | ✅ Cotización reanudable (`quoteCancelled`, no borrar) | `pedidos/context.ts`, `index.ts` | S |
| 2 | ✅ Pedido sticky en el router | `bot/router.ts`, `webhook/route.ts`, `bot/engine.ts` | S |
| 3 | ✅ Intérprete general (ops tipadas) | `pedidos/interpret-changes.ts` | M |
| 4 | ✅ `unsupported` + anti-repetición en la cotización | `index.ts:handleQuoteApproval` | S |
| 5 | ✅ Estado fresco expuesto al orquestador | `bot-assistant/tool-registry.ts` (`consultar_estado_pedido` / `_confirmaciones_pendientes` / `_ultima_escritura`) | M |
| 6 | ✅ Delegación determinística (ruteo sticky ampliado) | `pedidos/intent.ts` (`looksLikeOrderSlotReply`), `bot/router.ts`, `index.ts` | M |
| 7 | ✅ Guard G3 + prompt de grounding | `bot-assistant/reply-guard.ts`, `prompts.ts`, `production.ts` | S |
| 8 | Enclíticos `intent.ts` (hecho en Fase 3) | `pedidos/intent.ts` | S |

> **Notas de implementación (Fases 1-4):**
> - Fase 3 cubre `set_price` (absoluto/% — el gap del incidente A), `set_quantity`
>   y `remove`, con fast-path para "línea N". Los cambios de **variante/medida**
>   siguen resolviéndose por el camino de re-cotización (`presentQuote`), que ya
>   funcionaba; moverlos al intérprete es una fase posterior si hace falta.
> - `interpret-modification.ts` se conserva (y sus tests) por compatibilidad.

## 9. Tests de aceptación (de los incidentes reales)

1. Reabrir tras `no`: `"perdon, si quiero que llo hagas presupuesto"` → reanuda la
   cotización (no assistant).
2. `"cambiale el precio al bastidor 142x195 a 300mil"` → cambia el precio de esa línea.
3. `"todos sin tela"` → recalcula (comportamiento ya correcto, fijarlo).
4. `"el cliente es Federico"` → candidatos **reales** de Federico (nunca César).
5. Guard G3: el orquestador **no** emite el formato de presupuesto; sin escritura
   confirmada, no afirma nada.
6. `"sacá el 2 y ponelo en 50000"` → op descartada con `unsupported` + oferta de seguir.

## 10. Rollout y observabilidad

- Las acciones del orquestador ya corren en `shadow` (`planner_shadow` en
  `router_logs.debug_info`): medir coincidencia y falsos positivos antes de `on`.
- Prender por dominio: `assistant` → `pedido` (el más sensible) → `expense` →
  `attendance`. Vouchers quedan congelados.
- Métrica madre: **% de turnos resueltos sin reformular** + **0 afirmaciones sin
  escritura** (G3).

## 11. Riesgos

- **Latencia:** orquestador + estado + bot = varias llamadas. Mitigar con fast-path
  determinístico (listas) antes del LLM y cache de catálogo por request.
- **Doble ejecución:** G6 + `bot_write_log`.
- **Historial como verdad:** prohibido por diseño (Capa 2); el estado fresco manda.
- **Regresión de "asumir y corregir":** el intérprete no debe bloquear; ante duda,
  `unsupported` con oferta de continuar, nunca un loop de preguntas.

## 12. Fuera de alcance

- No reactivar `ai/chatbot.ts` ni reintroducir `voice-orders`.
- No cambiar voucher/Flows/gastos/asistencia salvo el contrato de estado fresco.
- No borrar nada de `interpret-modification.ts` hasta que el intérprete general
  cubra sus 3 operaciones (tests de paridad).

## 13. Referencias

- Flujo actual: `src/lib/pedidos/index.ts`, `summary.ts`, `interpret-modification.ts`,
  `interpret-reply.ts`, `understand.ts`, `client-identity.ts`, `intent.ts`.
- Orquestador existente: `src/lib/bot-assistant/{agent,prompts,production,tool-registry}.ts`,
  `src/lib/bot/{engine,planner,policy}.ts`.
- Evidencia: `router_logs` / `bot_traces` (conv `05fe8f78…`, 15/10/2026).
- Relacionado: `docs/bots/plans/plan-unificacion-motor-bot.md`, `docs/bots/definicion-ambiguedad.md`,
  `docs/bots/archive/notas-fallos-reales.md`, `docs/bots/decisiones-y-gotchas.md`.
