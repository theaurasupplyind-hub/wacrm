# Arquitectura de Bots — wacrm

> Documento de arquitectura del ecosistema de bots del fork. Estado: **actual**.
> Documentos relacionados:
> - Voucher: [`vouchers.md`](./vouchers.md) · Voice Orders: [`voice-orders.md`](./voice-orders.md)
> - Históricos: [`archive/README.md`](./archive/README.md)
>
> ⚠️ **Nota de estado (2026-10):** el pipeline de **Voice Orders / pedidos**
> (`src/lib/voice-orders/*`, `handleVoiceText`, `processTextOrder`,
> `createPresupuesto`, `/api/budget-image`, `hasPendingVoice`) **ya no existe en
> el código**. Esto se refiere al módulo `src/lib/voice-orders/*` y sus rutas
> antiguas, no al handler actual de `src/lib/pedidos/`: `BotIntent` sí contempla
> `pedido` y esa ruta sigue documentada en §6. La sección 2 y `voice-orders.md`
> quedan como referencia histórica; la sección 6 describe el dispatch vigente.
> Lo que sí está vivo: Flows, Voucher
> (imagen/texto), Gastos, Asistencia y el asistente conversacional.

## Visión General del Ecosistema

```
┌─────────────────────────────────────────────────────────────┐
│                     wacrm (Next.js 16)                      │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                 WhatsApp Webhook                      │   │
│  │   POST /api/whatsapp/webhook ← Meta Cloud API        │   │
│  └──────────┬───────────────────────────────────────────┘   │
│             │                                               │
│    ┌────────┴────────┐                                      │
│    │  ProcessMessage  │                                      │
│    └──┬──┬──┬──┬──┬──┘                                      │
│       │  │  │  │  │                                         │
│  ┌────┘  │  │  │  └──────────┐                              │
│  │   ┌───┘  │  └──────┐      │                              │
│  ▼   ▼      ▼         ▼      ▼                              │
│ ┌──┐ ┌──┐ ┌──────┐ ┌────┐ ┌──────┐ ┌────────┐              │
│ │  │ │  │ │Voz & │ │Vou-│ │Flows │ │Gastos  │              │
│ │  │ │  │ │Texto │ │cher│ │Engine│ │/Expense│              │
│ └──┘ └──┘ └──┬───┘ └┬───┘ └──────┘ └────┬───┘              │
│              │       │                    │                  │
│              ▼       ▼                    ▼                  │
│     ┌──────────────────────────────────────┐                 │
│     │        facbal/client.ts            │ ← API Key auth   │
│     └──────────────┬───────────────────────┘                 │
└────────────────────┼─────────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────────┐
│          backend_gal (FastAPI — Render.com)                  │
│  https://api-bastidores.onrender.com                        │
│  Endpoints: /invoices, /clients, /products, /payments,      │
│  /expenses, /expense-categories...                          │
└──────────┬───────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────┐
│          galv2-tauri (Tauri + Svelte 5 Desktop App)         │
│  Consume la misma API backend_gal                           │
└──────────────────────────────────────────────────────────────┘
```

---

## 1. Chatbot Bastidores GAL (DESHABILITADO)

**Estado:** ❌ `CHATBOT_ENABLED = false` en `src/lib/ai/chatbot.ts:20`

**Propósito:** Bot de pedidos por WhatsApp para Bastidores GAL. Entiende solicitudes de productos, calcula precios, arma carrito y confirma pedidos.

### Archivos clave

| Archivo | Rol |
|---------|-----|
| `src/lib/ai/chatbot.ts` | Orchestrador principal (1340 líneas) |
| `src/lib/ai/chatbot-logger.ts` | Logger de auditoría |
| `src/lib/ai/cart-state.ts` | Estado del carrito (interfaces, CRUD) |
| `src/lib/ai/conversation-flow.ts` | Máquina de estados (confirmar/derivar/continuar) |
| `src/lib/ai/handoff-rules.ts` | Reglas de derivación a humano (regex + LLM) |
| `src/lib/ai/build-invoice-payload.ts` | Construye payload para crear factura |
| `src/lib/facbal/client.ts` | Cliente API para backend_gal |

### Por qué está deshabilitado

El refactor planificado en `archive/refactor-chatbot.md` quedó incompleto. Esta
implementación monolítica/reglas+LLM es legado y permanece deshabilitada. El
asistente conversacional y el handler actual de pedidos están separados; no
reactivar `chatbot.ts` como atajo para modificar esos flujos.

### Base de datos (Supabase migrations)

| Migration | Tabla/Columna | Propósito |
|-----------|---------------|-----------|
| `032_chatbot_logs.sql` | `chatbot_logs` | Traza de auditoría |
| `033_order_context.sql` | `conversations.order_context` (JSONB) | Estado del carrito |
| `034_chatbot_pending_batches.sql` | `chatbot_pending_batches` | Debounce de 8s para mensajes fragmentados |

---

## 2. Voice Orders / Bot de pedidos (RETIRADO)

**Estado:** ⚠️ Retirado del código vigente (nota 2026-10). El documento
[`voice-orders.md`](./voice-orders.md) queda como referencia histórica; no
asumir que sus rutas o capacidades siguen desplegadas.

**Propósito histórico:** tomar pedidos por voz o texto vía WhatsApp, resolver
precios y crear presupuestos/facturas. Esa descripción ya no representa el
pipeline activo.

> El documento [`voice-orders.md`](./voice-orders.md) describe el módulo
> anterior y se conserva solo como referencia histórica.

### Base de datos

| Migration | Tabla/Columna | Propósito |
|-----------|---------------|-----------|
| `035_voice_context.sql` | `conversations.voice_context` (JSONB) | Estado entre mensajes (variantes pendientes, client name, invoice) |

---

## 3. Voucher Processing (ACTIVO)

**Estado:** ✅ Activo

**Propósito:** Cuando un cliente envía imagen/PDF de un comprobante de pago por WhatsApp, extrae los datos vía IA (visión), los empareja con facturas pendientes en FacBal/backend_gal mediante un pipeline de fases con pool de candidatos, y registra el pago automáticamente cuando hay match confiable.

> Documento dedicado con la spec de matching + pipeline actual:
> **[`vouchers.md`](./vouchers.md)** — también existe una descripción en inglés
> de la implementación en [`docs/voucher-flow.md`](../voucher-flow.md).

### Archivos clave

| Archivo | Rol |
|---------|-----|
| `src/lib/ai/voucher-pipeline.ts` | Orquestador: descarga media → extracción → fases → decisión → staging → pago |
| `src/lib/ai/voucher-extraction.ts` | OpenRouter multimodal (`google/gemini-2.5-flash`) → JSON estructurado |
| `src/lib/ai/voucher-matching.ts` | Helpers: `montoDistance`, `findExactClientSumMatches`, thresholds |
| `src/lib/ai/voucher-context.ts` | Estado multi-turn en `conversations.voucher_context` |
| `src/lib/facbal/client.ts` | `matchVoucherByName`, `createVoucherReview`, `registrarPago` |
| `src/app/(dashboard)/voucher-debug/page.tsx` | Dashboard de debug con timeline por fase |

### Variables de entorno

| Variable | Requerida | Default | Uso |
|----------|-----------|---------|-----|
| `OPENROUTER_API_KEY` | Sí | — | Extracción IA |
| `VOUCHER_AI_MODEL` | No | `google/gemini-2.5-flash` | Override del modelo |
| `FACBAL_API_URL` | Sí | — | backend_gal |
| `FACBAL_API_KEY` | Sí | — | Header `X-API-Key` |

### Base de datos

| Migration | Tabla / columna | Propósito |
|-----------|-----------------|-----------|
| `031_voucher_extractions.sql` | `voucher_extractions` | Auditoría de cada extracción |
| `040_voucher_context.sql` | `conversations.voucher_context` | Estado multi-turn (pending + buffer de texto) |
| `041_voucher_debug_info.sql` | `voucher_extractions.debug_info` | Timeline de fases para debug UI |
| `042_voucher_match_status_multi_invoice.sql` | CHECK + `multi_invoice` | Distinguir multi_invoice de ambiguous en DB |
| `043_voucher_atomic_pending.sql` | RPCs `voucher_append_pending` / `voucher_remove_pending` | Fix de race condition en pendientes simultáneos |

---

## 4. Flows Engine (ACTIVO)

**Estado:** ✅ Activo — feature nativa de wacrm

**Propósito:** Bot builder visual sin código.

### Archivos clave

| Archivo | Rol |
|---------|-----|
| `src/lib/flows/engine.ts` | Motor de ejecución de flujos |
| `src/lib/flows/meta-send.ts` | Funciones de envío (text, buttons, list, media) |
| `src/lib/flows/types.ts` | Tipos de nodos y flujos |

### Prioridad en webhook

**#1** — Se ejecuta antes que cualquier otro sistema. Si un flujo consume el mensaje, suprime AI Auto-Reply y Voice Orders.

---

## 5. AI Auto-Reply (ACTIVO)

**Estado:** ✅ Activo — configurable por cuenta (bring-your-own-key)

**Propósito:** Respuestas automáticas por IA a mensajes de clientes usando OpenAI o Anthropic.

### Archivos clave

| Archivo | Rol |
|---------|-----|
| `src/lib/ai/auto-reply.ts` | Dispatch |
| `src/lib/ai/generate.ts` | Generador de respuestas |
| `src/lib/ai/context.ts` | Builder de contexto de conversación |
| `src/lib/ai/knowledge.ts` | Búsqueda en base de conocimiento |
| `src/lib/ai/providers/` | Implementaciones de proveedores (OpenAI, Anthropic) |

**Nota:** Sistema **completamente separado** del chatbot de Bastidores. Usa su propia config de IA por cuenta, no OpenRouter.

---

## 6. Webhook y asistente conversacional (actual)

```text
POST /api/whatsapp/webhook
  ├─ Lifecycle/status de Meta; persistir mensaje y resolver remitente/cuenta
  ├─ Gate bot_allowed_numbers para las funciones internas
  ├─ Confirmaciones interactivas y pendientes (gastos/asistencia/voucher/pedido)
  ├─ Imágenes/PDF de remitentes autorizados → pipeline de voucher
  ├─ Audio → transcripción; luego comparte el flujo de texto
  ├─ Comandos cancelar/reiniciar
  ├─ extractBotMessage() → UnifiedExtraction + contexto pendiente
  └─ MOTOR DE TURNO (src/lib/bot/engine.ts → planTurn, función pura)
       ├─ clarify (expired/resolve/cancel/supersede/reask/ask)
       ├─ decideDispatch() → dominio
       ├─ Planner LLM (opcional; ver Fases 3-5 abajo)
       │    ├─ shadow: sólo registra en router_logs/bot_traces (no cambia nada)
       │    └─ on + ASSISTANT_PLANNER_DOMAINS: conduce el turno; `reconcilePlans`
       │         aplica guardrails (vouchers congelados, pendientes, policy)
       └─ acciones por dominio → el adapter las materializa en bgTasks:
            ├─ gasto/multi_expense → handler de gastos
            ├─ asistencia_*       → handler de asistencia
            ├─ voucher            → flujo de voucher (pass-through, congelado)
            ├─ pedido             → cotización preview o creación explícita
            └─ factura/consulta/conversación → asistente
  ├─ Assistant branch → runAssistantForWebhook() (fire-and-forget)
  │    └─ historial + KB + estado/extracción → loop de tool-calling
  │         si no genera texto o falla → fallback a AI Auto-Reply
  ├─ Fallback de respuesta / Flows fallback (si FLOWS_ENABLED=true)
  ├─ Automations
  └─ dispatchWebhookEvent()
```

**La orquestación de texto está centralizada en el motor de turno** (`src/lib/bot/engine.ts`): contextos → extracción → clarify → router → acciones. `route.ts` quedó como **adapter delgado** que hace el I/O (aplica `clear_context`/`save_clarify`, envía y dispara los handlers dentro de los `bgTasks` que ve `after()`).

El **planner LLM es opt-in** y default `off`: no reemplaza al router determinístico salvo que se habilite por dominio. Los handlers siguen siendo la autoridad de negocio (validaciones, confirmaciones y efectos de gastos, asistencia, vouchers y pedidos).

### Motor de turno y planner (Fases 1-5)

- **Motor puro** (`src/lib/bot/engine.ts`): `planTurn(state) → TurnPlan { dispatchedTo, dispatchReason, extraction, actions }`. Sin I/O ni Supabase.
- **Policy** (`src/lib/bot/policy.ts`): tope de escrituras por turno (`maxWritesPerTurn = 1`), el texto de toda escritura es el del usuario (nunca el del modelo) y dedupe dentro del turno.
- **Planner** (`src/lib/bot/planner.ts`): reusa `buildAgentMessages` + `agentToolDefinitions`; propone `TurnAction`s y **nunca ejecuta**.
- **Reconciliación** (`reconcilePlans`): decide determinístico vs planner con guardrails — planner caído, clarify pendiente o **vouchers** → gana el determinístico; dominio no habilitado → determinístico; pendiente multi-turno con otro dominio → determinístico; escrituras del planner requieren `ASSISTANT_PLANNER_WRITES=true`.
- **Vouchers congelados**: nunca entran al planner.

##### Rollout por env

| Env | Uso | Default |
|---|---|---|
| `ASSISTANT_AGENT_PLANNER` | `off` \| `shadow` \| `on` | `off` |
| `ASSISTANT_PLANNER_DOMAINS` | Dominios que el planner conduce (csv: `assistant,pedido,expense,attendance`) | vacío |
| `ASSISTANT_PLANNER_WRITES` | Habilita escrituras del planner (`true`/`false`) | `false` |
| `PLANNER_MODEL` | Modelo del planner | cae a `ASSISTANT_MODEL` |

Sugerido: `shadow` (mide) → `on` + `assistant` (lectura) → `+pedido` → `+expense` → `+attendance` → `ASSISTANT_PLANNER_WRITES=true`. Ver `planner_shadow` en `router_logs.debug_info` para coincidencia y falsos positivos.


El flujo de pedido trata una pregunta de disponibilidad/precio como cotización
de solo lectura y ofrece convertirla en presupuesto. Una orden explícita de
creación inicia el flujo formal, con confirmación antes de escribir. Usa los
defaults existentes (`Retira`, sin fecha, sin descuento) y no usa ni guarda el
teléfono interno del remitente como teléfono/nombre del cliente. `cancelar` y
`reiniciar` limpian también `order_context`.

### Contexto del agente

- `buildConversationContext()` carga mensajes de texto recientes desde
  `messages` (20 por defecto; configurable con `AI_CONTEXT_MESSAGE_LIMIT`).
- `buildAgentMessages()` conserva los roles `user`/`assistant`, limita el
  historial a 20 mensajes incluido el actual y evita duplicar el mensaje
  entrante.
- El webhook pasa `UnifiedExtraction` y `buildBotContextText()` como pistas; el
  texto original y las respuestas de las herramientas son la fuente de verdad.
- Los estados pendientes de gastos, asistencia, vouchers, pedidos y clarify
  siguen en contextos separados. Aún no existe una memoria resumida/unificada
  entre conversaciones.

### Herramientas y modelo

El registro vive en `src/lib/bot-assistant/tool-registry.ts`: consultar
facturas/gastos/proveedores/empleados/categorías/productos, cotizar pedidos y
registrar gastos/asistencia. El agente selecciona herramientas por OpenRouter;
los handlers existentes ejecutan las operaciones. La mejora de contexto no
añadió capacidades de negocio.

| Env | Uso | Default actual |
|---|---|---|
| `OPENROUTER_API_KEY` | API del extractor y agente | — |
| `EXTRACTOR_MODEL` | Extracción/ruteo | `google/gemini-2.5-flash-lite` |
| `ASSISTANT_MODEL` | Agente y redacción | default de `openrouter.ts`: `google/gemini-2.5-flash-lite` |
| `ASSISTANT_TOOLS_ENABLED` | Desactiva el loop si vale `false` | Habilitado si no vale `false` |
| `VOUCHER_AI_MODEL` | Extracción multimodal de vouchers/gastos | `google/gemini-2.5-flash` |

**Piloto pendiente:** probar `deepseek/deepseek-v4.1-flash` por OpenRouter en
`ASSISTANT_MODEL` y `EXTRACTOR_MODEL`; mantener `VOUCHER_AI_MODEL` en Gemini
hasta evaluar el conjunto de comprobantes. No consta aplicado en Vercel ni
validado en producción.


---

## 7. Conexión con backend_gal (FacBal API)

**URL:** `https://api-bastidores.onrender.com`
**Auth:** `X-API-Key` header (desde `FACBAL_API_KEY` env var)
**Cliente:** `src/lib/facbal/client.ts`

### Endpoints del backend

La tabla conserva integraciones históricas de pedidos; para las herramientas
que el agente ofrece hoy, la fuente de verdad es `src/lib/bot-assistant/tool-registry.ts`
y el cliente `src/lib/facbal/client.ts`.

| Endpoint | Usado por |
|----------|-----------|
| `GET /invoices/pending-by-phone?telefono=` | Chatbot, Voucher |
| `POST /payments` | Voucher |
| `GET /clients` | Chatbot, Voice Orders |
| `POST /clients` | Voice Orders |
| `GET /products/search?q=` | Chatbot |
| `GET /products/suggest-price?q=` | Chatbot, Voice Orders |
| `POST /products/bulk-price` | Chatbot, Voice Orders |
| `GET /price-list-images` | Chatbot |
| `GET /price-list-images/{id}/view` | Chatbot |
| `POST /invoices` | Voice Orders |
| `GET /expense-categories` | Expense Bot |
| `POST /expense-categories` | Expense Bot / FacGal |
| `POST /expenses` | Expense Bot / FacGal |
| `GET /expenses` | Expense Bot / FacGal |
| `GET /expenses/summary` | Expense Bot / FacGal |
| `POST /attendance` | Asistencia Bot (upsert por empleado + día; acepta `exit_time`) |
| `GET /attendance` | Asistencia Bot (filtros `employee_id`, `month`, `date`; devuelve `exit_time`) |

### Endpoints adicionales del ecosistema

- `GET /providers` / `POST /providers` / `POST /providers/movements` — proveedores y movimientos
- `GET /employees` / `POST /employees/payments` — empleados y pagos

---

## 8. Conexión con galv2-tauri

**Relación:** `galv2-tauri` es una **aplicación de escritorio Tauri** (Svelte 5 + Rust) independiente que **comparte el mismo `backend_gal`** (FacBal API). No se conecta directamente a `wacrm`.

### Puntos de integración

- Misma base de datos PostgreSQL (NeonDB) compartida vía `backend_gal`
- `build-invoice-payload.ts:30` — comentario referencia que `buildItemDescription` genera descripciones "like galv2-tauri uses"
- Ambos sistemas comparten el mismo API key para `backend_gal`
- Voice Orders propone una pantalla de confirmación en `galv2-tauri` antes de enviar pedidos a WhatsApp (ver [`voice-orders.md`](./voice-orders.md) §3)

### Print Agent en galv2-tauri

`galv2-tauri` tiene su propio sistema autónomo: un **Print Agent** (`src-tauri/src/print_agent.rs`) que:

- Polling cada 10s a `GET /print-jobs/pending?station_id={id}`
- Descarga e imprime PDFs automáticamente
- Envía heartbeats cada 5min
- **No tiene relación con wacrm** — es un sistema separado

---

## 9. Resumen de IA (estado actual)

| Sistema | Proveedor | Modelo | Propósito |
|---------|-----------|--------|-----------|
| Extractor/ruteo del bot interno | OpenRouter (`EXTRACTOR_MODEL`) | `google/gemini-2.5-flash-lite` por defecto | Intent + campos estructurados |
| Agente conversacional | OpenRouter (`ASSISTANT_MODEL`) | `google/gemini-2.5-flash-lite` por defecto | Selección de herramientas + respuesta |
| Voucher / extracción multimodal de gasto | OpenRouter (`VOUCHER_AI_MODEL`) | `google/gemini-2.5-flash` | Imagen/PDF |
| Transcripción de audio | OpenRouter | `openai/whisper-1` | Transcripción cuando aplica |
| AI Auto-Reply | OpenAI/Anthropic | Configurable por cuenta | Respuestas automáticas |

> DeepSeek V4.1 Flash es un piloto propuesto para agente y extractor, no un
> modelo confirmado como desplegado. El chatbot legado de `chatbot.ts` sigue
> deshabilitado y no representa al asistente productivo.

---

## 10. Expense Bot / Gastos (ACTIVO)

**Estado:** ✅ Activo — registro de egresos multimodal desde WhatsApp.

**Propósito:** Permitir registrar cualquier egreso de la fábrica/negocio directamente desde WhatsApp (texto, audio, imagen o PDF) y mantener los datos sincronizados entre wacrm, backend_gal y galv2-tauri (FacGal).

### Principios de diseño

1. **No se borran datos existentes.** Se usan tablas nuevas (`expense_categories`, `expenses` en backend_gal) y se migró el histórico desde `movimientos_proveedor` y `pagos_empleados` sin eliminarlos.
2. **Tablas de proveedores y empleados se mantienen.** `proveedores` y `empleados` siguen siendo la fuente de verdad de esas entidades. `movimientos_proveedor` y `pagos_empleados` se vinculan con `expenses` mediante `expense_id`.
3. **Categorías dinámicas.** El bot puede crear categorías automáticamente si no existen y avisar al usuario.
4. **Acceso por número autorizado.** El bot interno se limita a números activos
   en `bot_allowed_numbers`; los demás contactos siguen por Flows/AI Auto-Reply.
5. **Reutiliza infraestructura existente.** Transcribe audio con Whisper (mismo modelo de Voice Orders) y lee comprobantes con Gemini Vision (mismo modelo de Voucher).

### Parser de montos

- Anclaje a palabras de dinero (`pagué $X`, `costo X`, `gasté X`, `transferí X`, ...) con ventana de oración que corta solo en puntos no numéricos; dentro de la ventana se elige el número más grande (excluye días/cantidades chicas de la descripción).
- Sufijos `mil` / `k` / `m` → ×1000 ("18 mil" → 18000).
- Formatos AR (`$18.000,00`) y US (`18,000.00`), decimales con coma o punto según contexto.
- Si el monto no queda anclado a una keyword, el parser marca `amountAmbiguous: true` (monto dudoso).

### Confirmación por ambigüedad

El bot **auto-guarda cuando todo está claro** (como antes) y solo pide confirmación interactiva cuando hay **ambigüedad**:

- el monto del parser es dudoso (`amountAmbiguous`);
- la categoría fue creada automáticamente (nueva);
- el proveedor/empleado no matcheó con ninguna entidad conocida.

En esos casos envía un preview (`buildExpensePreview`) con botones **[✅ Confirmar] [✏️ Corregir] [❌ Cancelar]** y guarda `expense_context.stage = 'confirming'`. El tap se intercepta en el webhook **antes** de Flows:

- ✅ Confirmar → ejecuta + audita (`expense_extractions`) + confirmación final.
- ✏️ Corregir → vuelve a `collecting` y pregunta qué campo (monto o categoría).
- ❌ Cancelar → limpia el contexto.

### Archivos clave en wacrm

```
src/lib/expenses/
├── index.ts              # Entry point: processExpenseMessage()
├── types.ts              # Expense, ExpenseCategory, ParsedExpense
├── parse-expense.ts      # Parser de texto a gasto estructurado
├── transcribe-expense.ts # Reutiliza Whisper para audio
├── extract-expense.ts    # Reutiliza Gemini para imagen/PDF
├── execute-expense.ts    # Pipeline FacBal: categoría/proveedor/empleado
├── confirm-expense.ts    # Envía resumen y botones por WhatsApp
├── fuzzy-match.ts        # Match categorías/proveedores/empleados
└── context.ts            # Estado multi-turno
```

### Base de datos (Supabase migrations)

| Migration | Tabla/Columna | Propósito |
|-----------|---------------|-----------|
| `036_expense_context.sql` | `conversations.expense_context` (JSONB) | Estado multi-turn (gasto pendiente de confirmación/corrección) |
| `037_expense_extractions.sql` | `expense_extractions` | Auditoría de cada extracción del bot |

> Las tablas `expense_categories` y `expenses` viven en **backend_gal**, no en wacrm.

---

## 11. Asistencia Bot / Llegada y salida (ACTIVO)

**Estado:** ✅ Activo — registro de llegadas, salidas y estados desde WhatsApp.

**Propósito:** Registrar la asistencia diaria de empleados directamente desde WhatsApp contra `backend_gal` (tabla `asistencias`, una fila por empleado + día).

### Mensajes soportados

- **Llegada** — keywords `llegó/llego/llegue/llegada` + hora ("llegó juan a las 8:30", "juan llegó a las 8:30"). Marca `TARDE-HH:MM` contra `entry_time` + `late_threshold` del empleado.
- **Salida** — keywords `salgo/sale/salí/salida/me voy/me fui/terminé/me retiro/chau/se fue` + hora ("me voy a las 17:00", "juan se fue a las 17:00"). Guarda `exit_time` sin pisar el `status` de llegada y avisa si difiere del horario esperado del empleado.
- **Estados** — `vacaciones`, `licencia`, `ausente` (guarda el status directamente).

### Reglas de secuencia y dedupe

1. **Salida sin llegada previa ese día** → se rechaza ("Primero registrá su llegada").
2. **Segunda llegada el mismo día** → NO se sobrescribe a ciegas: pregunta con botones **[✅ Corregir hora] [❌ No tocar]** (✅ sobrescribe recomputando `TARDE-`; ❌ no toca).
3. **Empleado no encontrado o sin nombre** → multi-turno: guarda contexto (`attendance_context`) y pregunta "¿De quién es?"; el próximo texto reintenta `searchEmployees`.

### Archivos clave en wacrm

```
src/lib/attendance/
├── index.ts              # Entry point: processAttendanceMessage()
├── parse-attendance.ts   # Parser texto → llegada/salida/estado + nombre
├── context.ts            # Estado multi-turno (attendance_context)
└── parse-attendance.test.ts
```

### Base de datos

| Migration | Tabla/Columna | Propósito |
|-----------|---------------|-----------|
| `044_attendance_context.sql` | `conversations.attendance_context` (JSONB) | Estado multi-turn (empleado pendiente, corrección de hora) |

> El campo `asistencias.exit_time` se agrega en **backend_gal** (`main.py`, modelo `Attendance` + ALTER de startup). `GET /attendance` acepta filtro `date` y devuelve `exit_time`.

### Routing en el webhook

- Las respuestas a los botones de corrección se interceptan **antes** de `dispatchInboundToFlows` y se marcan como consumidas.
- Un texto mientras hay asistencia pendiente (empleado a resolver o botón esperando) se rutea al bot de asistencia y **suprime Voice Orders** (`hasPendingAttendance` en `shouldSuppressVoiceOrder`).

---

## 12. Mejoras Propuestas / Roadmap

### Corto plazo
1. **Router unificado de intents** — reemplazar el bloque de dispatch por regex/LLM binario con umbral de confianza de 3 niveles (plan: `archive/bot-personal.md`)
2. **Mejoras de Voice Orders** — ambigüedad del LLM, confirmación por WhatsApp, panel FacGal (ver [`voice-orders.md`](./voice-orders.md))
3. **Filtrado del disparo del pipeline de vouchers** — no procesar cualquier imagen; solo comprobantes probables (gate por caption/keywords/contexto)
4. **Agregar más tests** para voice-orders pipeline

### Mediano plazo
5. **Webhook de FacBal hacia wacrm** — en lugar de polling, que FacBal notifique cambios
6. **Sincronización bidireccional** entre wacrm y galv2-tauri para evitar conflictos
7. **Dashboard en galv2-tauri** para monitorear pedidos entrantes desde wacrm

### Largo plazo
8. **Manejo de cola de impresión** desde wacrm (actualmente solo en galv2-tauri Print Agent)
9. **Notificaciones push** desde wacrm a galv2-tauri para nuevos pedidos
