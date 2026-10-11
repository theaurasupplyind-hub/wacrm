# Plan: automatización desde WhatsApp + asistente en desktop (cerebro en backend_gal)

> Para un agente implementador. **Estado:** planificado — no iniciado.
> **Objetivo:** centralizar el "cerebro" conversacional en `backend_gal`, automatizar primero desde WhatsApp, y (más adelante, no urgente) embeber un asistente en `galv2-tauri` que consuma el mismo cerebro y LLM.
>
> Contexto relacionado: `docs/bots/architecture.md`, `docs/bots/plan-unificacion-motor-bot.md`, `docs/bots/gaps-bot-gastos.md`, `resumen-bot-beta.md`.

---

## 1. Decisiones tomadas

| Tema | Decisión |
|---|---|
| Prioridad | **1° automatizar más desde WhatsApp.** El asistente en desktop **no es urgente**. |
| Cerebro | **`backend_gal`** (FastAPI). La lógica de intención, orquestación de acciones y acceso a datos vive ahí. |
| LLM | **Compartido** entre desktop y wacrm, provisto por `backend_gal` (una sola config, una sola key). |
| Pedidos/presupuestos | **A evaluar con cuidado.** El dueño crea pedidos más rápido en el desktop; si se hace por chat, debe ser **muy bueno** (si no, no vale la pena). |
| Escrituras sin confirmación | **Solo las actuales** (gastos/asistencia con su regla vigente; vouchers automáticos). Las nuevas escrituras nacen **con confirmación** y se promueven a auto-guardado recién con pruebas. |
| Usuarios del asistente | **Todos** (dueño y operarios), pero autenticado (no público). |
| Fuera de alcance por ahora | Voice en desktop, programar viajes por chat, migración completa del pipeline de vouchers. |

---

## 2. Arquitectura objetivo

```
                 ┌──────────────────────────────────────────────┐
   WhatsApp ───► │ wacrm (Next.js)                              │
                 │  transporte: webhook, media, envío,          │
                 │  Flows/Automations, contexts multi-turn      │
                 └───────────────┬──────────────────────────────┘
                                 │ POST /assistant/run (X-API-Key)
                                 ▼
                 ┌──────────────────────────────────────────────┐
                 │ backend_gal (FastAPI)  ← CEREBRO             │
                 │  - LLM gateway (OpenRouter) compartido       │
                 │  - extracción/intención + tool catalog       │
                 │  - ejecución de acciones sobre su propia DB  │
                 └───────────────┬──────────────────────────────┘
                                 │ (mismo endpoint, token de app)
                                 ▲
                 ┌───────────────┴──────────────────────────────┐
                 │ galv2-tauri (desktop)                        │
                 │  UI + PDF/impresión + (futuro) paleta NL     │
                 └──────────────────────────────────────────────┘
```

**Principios**
- Una sola definición de **tools/acciones** y un solo **LLM**, en `backend_gal`.
- `wacrm` y `galv2-tauri` son **clientes** del cerebro: no reimplementan intención.
- Los writes siguen la política de confirmación; el cerebro devuelve "acciones propuestas" y el cliente confirma.
- La resolución de entidades (cliente, factura, proveedor, empleado) vive en `backend_gal` (tiene la DB).

---

## 3. Fase 0 — Fundaciones en `backend_gal`

**Objetivo:** que exista el cerebro antes de tocar los clientes.

1. **LLM gateway** (`assistant/llm.py` o similar):
   - Cliente OpenRouter server-side (`OPENROUTER_API_KEY` en `backend_gal/.env`, ya hay `ORS_API_KEY` como precedente de envs).
   - Config única: modelo, temperatura, `max_tokens`, timeouts, reintentos.
   - Funciones: `classify_intent(text, context)`, `extract_fields(...)`, `chat(...)`, `vision_extract(...)` (para vouchers a futuro).
   - Observabilidad: log de tokens/costo por llamada (tabla `assistant_llm_logs`).
2. **Tool catalog** (`assistant/tools.py`):
   - Esquema único por tool: `name`, `description`, `params` (JSON Schema), `handler`, `write: bool`, `requires_confirmation: bool`.
   - Los handlers llaman a funciones internas de `backend_gal` (no HTTP round-trip).
   - Registro central exportado para: (a) el loop del agente, (b) el endpoint, (c) introspección.
3. **Endpoint** `POST /assistant/run`:
   - Input: `{ channel: 'whatsapp'|'desktop', text, user_ref, context, allow_writes }`.
   - Pipeline: contexto → intención → tool selection/ejecución (solo reads si `allow_writes=false`) → respuesta grounded.
   - Output: `{ reply, intent, actions: [...], proposed_writes: [...], tool_logs, usage }`.
   - Auth: `X-API-Key` (wacrm) y un token de app para el desktop (ver Fase 4).
4. **Auth del desktop:** hoy `galv2-tauri` llama sin key. Para `/assistant/run` exigir un token de aplicación (`ASSISTANT_APP_TOKEN`) configurable en `AppConfig`.

**Criterio de salida:** `/assistant/run` responde consultas simples (ej. "¿cuánto debe Gómez?") usando tools de lectura.

---

## 4. Fase 1 — WhatsApp: automatizar consultas (read-only)

**Objetivo:** que el asistente responda más preguntas reales, sin riesgo (solo lectura).

1. `wacrm` agrega un cliente hacia `backend_gal` (`src/lib/facbal/client.ts` → `runAssistant`).
2. El router/asistente de `wacrm` delega en `/assistant/run` para intents consultivos; los flujos actuales (gastos/asistencia/vouchers) **quedan intactos**.
3. Tools de lectura a exponer:

| Tool | Datos backend | Ejemplo de mensaje |
|---|---|---|
| `estado_pedido` | `GET /invoices?search=` | "¿cómo va el pedido de Gómez?" |
| `deuda_cliente` | `matchVoucherByName` / pending | "¿cuánto debe Aldo?" |
| `resumen_caja` | `/payments` + `/expenses/summary` | "¿cuánto entró hoy?" |
| `stock_proveedor` | `/providers/{id}` (balance, stock) | "¿cuánta varilla queda?" |
| `gastos_periodo` | `/expenses` (ya existe) | "gastos de ayer" |
| `asistencia` | `/attendance` (ya existe) | "¿quién faltó ayer?" |

**Criterio de salida:** N consultas reales respondidas con grounding, sin tocar ninguna escritura.

---

## 5. Fase 2 — WhatsApp: escrituras con confirmación

**Objetivo:** sumar acciones de escritura, siempre con confirmación explícita (política actual).

| Tool | Acción | Confirmación |
|---|---|---|
| `cambiar_estado_pedido` | `PATCH /invoices/{id}` (`estado_kanban`/`estado_entrega`/`estado_moldura`/`estado_orden_tela`) | Preview + "¿confirmás?" |
| `crear_tarea` | `POST /tasks` | Preview |
| `movimiento_stock` | `POST /providers/movements` (`STOCK_IN`/`STOCK_OUT`) | Preview |
| `pago_manual` | `POST /payments` (no-voucher) | Preview |
| `marcar_impresa` | `POST /invoices/print/batch` | Preview |

Reglas:
- El cerebro devuelve `proposed_writes`; el cliente (wacrm) muestra preview con botones y **no ejecuta** hasta el tap.
- Reutilizar el patrón `clarify`/`expense_context` existente para el estado de la confirmación.
- Cada tool nueva se promueve a auto-guardado **solo** tras pruebas (decisión del usuario).

**Criterio de salida:** cambiar el estado de un pedido real por WhatsApp con confirmación y verlo reflejado en el Kanban del desktop.

---

## 6. Fase 3 — Pedidos/presupuestos por chat (condicionada)

**Solo si cumple el listón "muy bueno".** El desktop ya lo hace más rápido; el chat debe aportar valor (dueño fuera del local, pedidos repetidos).

1. Reutilizar clientes ya existentes en `wacrm`: `createInvoice`, `searchClients`, `createClient`, `suggestPrice`, `bulkPrice`, `buscarProductos`.
2. Resolución en el cerebro: cliente (fuzzy) + medidas (`NxM`, `Ø`, promos) + precios (`suggestPrice`).
3. Preview con ítems + total → confirmación → `createInvoice` → PDF/imagen para WhatsApp.
4. **Gate de calidad:** arnés de evaluación (golden set de pedidos reales) con umbral mínimo de acierto antes de exponerlo a producción.
5. Si no alcanza el listón, **no se implementa** y se prioriza Fase 4/5.

**Criterio de salida (o descarte):** decisión documentada tras la evaluación.

---

## 7. Fase 4 — Asistente en desktop (no urgente)

**Objetivo:** agilizar el desktop reusando el mismo cerebro.

1. **Paleta NL (Ctrl+K)** en `galv2-tauri` (`src/lib/screens/`): input de texto → `POST /assistant/run` con **contexto de UI** (pantalla actual, factura/cliente seleccionados).
2. **Contexto**: en Facturación prellena ítems con el motor local (`precios.ts`) y valida contra `suggestPrice`; en Kanban mueve tarjetas; etc.
3. **Auth**: token de app en `AppConfig` (`config.rs`, campos con `#[serde(default)]`).
4. **Allowlist HTTP**: agregar el dominio del cerebro a `src-tauri/capabilities/default.json` (`http:allow-fetch`).
5. **Ventana**: opción paleta embebida o ventana `assistant` (patrón `whatsapp-helper`/`maps-picker`).
6. **Seguridad (prerequisito)**: endurecer `CSP=null` y revisar el webview externo `maps-picker` en capabilities antes de exponer más superficie.
7. **Voz (opcional, posterior)**: Web Speech API.

**Criterio de salida:** "cambiá el estado del pedido de Gómez a listo" funciona desde la paleta del desktop.

---

## 8. Fase 5 — Consolidación

1. **Reemplazar `quickExpense.ts`** del desktop por el cerebro compartido (hoy es una versión pobre del parser del bot).
2. **Unificar la vía de escritura de gastos** (`gaps-bot-gastos.md` G8): el desktop debe escribir `Expense` (el backend crea los movimientos legacy), no movimientos legacy directo.
3. **Unificar precios**: `precios.ts` local vs `suggestPrice` del backend → una sola fuente.
4. **Observabilidad del LLM**: dashboard de tokens/costo, prompts versionados, evaluación continua.
5. **Migrar el pipeline de vouchers** al cerebro (hoy en `wacrm`) si aporta (opcional).

---

## 9. Riesgos

| Riesgo | Mitigación |
|---|---|
| Doble vía de escritura de gastos (desktop legacy vs bot `Expense`) | Fase 5.1/5.2 antes de automatizar más gastos. |
| Motor de precios duplicado (local vs backend) | Backend como fuente única; local solo para preview. |
| Mover el cerebro a `backend_gal` puede regresar intents ya afinados | Mantener el router de `wacrm` como fallback durante la transición; arnés de evaluación. |
| Seguridad desktop (`CSP=null`, webview externo con IPC) | Endurecer antes de Fase 4. |
| `backend_gal` es un monolito (6103 líneas, 175 endpoints) | Nuevo módulo `assistant/` aislado; no tocar endpoints existentes. |
| Costos de LLM compartido | Logs de uso + límites por cuenta/canal. |

---

## 10. Verificación

- `wacrm`: `npm run lint` (0 errores) · `npm run typecheck` · `npm test` · `npm run build`.
- `backend_gal`: tests del módulo `assistant/` (tools, intención) + smoke de `/assistant/run`.
- `galv2-tauri`: `npm run check` (svelte-check + tsc) en Fase 4.
- **E2E WhatsApp:** consultas (Fase 1) y cambios de estado con confirmación (Fase 2) reflejados en el desktop.
- **Arnés de intents** (`wacrm/src/lib/bot-llm/eval.ts`) ampliado con casos reales de `router_logs`.

---

## 11. Fuera de alcance (explícito)

- Programar viajes/entregas por chat (requiere coordenadas).
- Notas, FODA, prospectos, analytics por chat (bajo valor).
- Migración completa de vouchers a `backend_gal` (se evalúa en Fase 5).
- UI de settings del asistente y permisos por rol (el asistente es para todos por ahora).

---

## 12. Orden de ejecución sugerido

1. Fase 0 (cerebro + endpoint + auth) — habilita todo lo demás.
2. Fase 1 (consultas WhatsApp) — valor inmediato, riesgo nulo.
3. Fase 2 (escrituras con confirmación) — valor alto, riesgo controlado.
4. Fase 3 (pedidos) — decisión de producto tras evaluación.
5. Fase 4 (desktop) — cuando Fase 1-2 estén estables.
6. Fase 5 (consolidación) — deuda técnica, en paralelo cuando convenga.

---

## Anexo A — Hallazgos de `backend_gal` (exploración, base para Fase 0)

### A.1 Estado actual
- **FastAPI monolito**: `main.py` (~6.9k líneas, **175 endpoints**), + módulos `pricing_rules.py`, `talleres.py`, `storage.py`, `analisis.py`, `database.py`. No usa Alembic: `Base.metadata.create_all` + `run_db_migrations()` con `ALTER ... IF NOT EXISTS` dentro de un `try/except` que **traga errores** (solo imprime "Migration Warning").
- **Sin LLM**: no hay cliente OpenAI/OpenRouter/Gemini/Anthropic. HTTP client = **`requests`** (sincrónico). No hay `httpx`/`aiohttp`.
- **Auth real**: `verify_api_key` es **no-op si `FACBAL_API_KEY` no está seteada** (y hoy no está). Es decir, casi todos los endpoints están **sin auth efectiva**. `verify_station_key` sí exige `X-Api-Key`.
- **CORS**: `allow_origins=["*"]` + `allow_credentials=True` (combinación inválida para navegadores con credenciales).

### A.2 Layout propuesto del módulo `assistant/`
```
backend_gal/assistant/
├── __init__.py
├── models.py     # tablas propias (assistant_llm_logs, assistant_turns) — importar antes del lifespan
├── llm.py        # gateway OpenRouter (requests o httpx), config, prompts, observabilidad
├── tools.py      # tool catalog: name, description, params(JSON Schema), handler, write, requires_confirmation
├── engine.py     # pipeline: contexto → intención → selección/ejecución de tools → respuesta grounded
└── router.py     # APIRouter(prefix="/assistant") → POST /assistant/run
```
- Registrar en `main.py` junto a los routers existentes (**línea ~1817-1818**: `app.include_router(assistant_router)`).
- **Evitar import circular**: `assistant.tools` debe importar modelos de `main` de forma **lazy dentro de funciones** (patrón de `analisis.py`), o mover modelos a `models.py` compartido. No hacer `from main import ...` a nivel módulo.
- **LLM en endpoints `def`**: `requests` bloquea el worker; usar `run_in_threadpool` (FastAPI) o `httpx.AsyncClient` para no colgar el event loop.

### A.3 Servicios internos a reutilizar (NO vía HTTP)
- **Precios**: `_extract_all_dims`, `_resolve_price`, `_process_single_dim_pair`, `_process_reglas`, `_apply_pricing_rules`, `_eval_condition`, `_round_price`, `_detect_category_variant` (main.py ~2532-3147).
- **Factura**: lógica de `create_invoice` (main.py 3704) + `get_next_atomic_number` (1245, `with_for_update`, **no commitea** — lo hace el caller) + `normalize_fecha_entrega` + descuento de stock.
- **Gastos**: `create_expense` (4655) con efectos (movimiento proveedor → balance/stock, pago empleado, splits); `update/delete` revierten proporcionalmente.
- **Pagos**: `create_payment` (3848) crea/revierte `ProviderMovement`/`EmployeePayment` según `entity_type`/`external_id`.
- **Voucher matching**: `_tokenize`, `_jaccard`, `_get_invoices_with_saldo` (3494-3531), `match_voucher` (3533).
- **Geocoding/ORS**: `_geocode_nominatim` (5275), `_ors_post` (5832).
- **Storage**: `storage.py` (`upload_bytes`, `download_bytes`, `public_url`, `storage_available`).

### A.4 Endpoints que el asistente usaría (y su auth actual)
| Dominio | Endpoints | Auth actual |
|---|---|---|
| Clientes | `GET/POST/PUT/DELETE /clients`, addresses, geocode | **none** |
| Facturas | `GET/POST/PUT/PATCH/DELETE /invoices`, `next_number`, `print/batch`, `trash`, `restore`, `resumen` | **none** (salvo `pending-by-phone`, `match-voucher` = key/no-op) |
| Pagos | `POST/GET/PUT/DELETE /payments` | **none** |
| Proveedores | `GET/POST/PUT/DELETE /providers`, `/providers/movements` | **none** |
| Empleados/asistencia | `/employees*`, `/employees/payments*`, `/attendance*` | **none** |
| Gastos | `/expenses*`, `/expense-categories*` | **none** |
| Productos/precios | `/products*`, `/precios-referencia*` | search/suggest/bulk = key/no-op |
| Tareas/notas/FODA | `/tasks*`, `/notes*`, `/foda` | **none** |
| Voucher reviews | `GET/DELETE/cleanup` | **none**; `POST` = key/no-op |

### A.5 Riesgos concretos a mitigar en Fase 0
1. **`/assistant/run` necesita auth propia** (no confiar en `verify_api_key`, que hoy no protege).
2. **Soft-deletes/estados**: filtrar `deleted_at`, `estado_kanban != 'NO_CONFIRMADO'`, `active`, `is_owner` para no devolver basura ni romper totales.
3. **Numeración de factura**: respetar la transacción única de `get_next_atomic_number` (`with_for_update`) para no duplicar/saltar números.
4. **Migraciones**: nuevas tablas del assistant vía `create_all` (importar modelos antes del `lifespan`); no depender del `try/except` que traga errores.
5. **CORS/auth**: revisar antes de exponer el asistente a más superficies (desktop).
6. **Blobs en DB**: usar `storage_available()` para no inflar la DB con media.

### A.6 Env nuevas en `backend_gal`
- `OPENROUTER_API_KEY` (LLM gateway), `ASSISTANT_MODEL`, `ASSISTANT_APP_TOKEN` (auth desktop), `ASSISTANT_MAX_TOKENS`, timeouts. `FACBAL_API_KEY` (si se activa auth real, coordinar con `wacrm`/desktop).
