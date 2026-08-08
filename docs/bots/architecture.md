# Arquitectura de Bots — wacrm

> Documento de arquitectura del ecosistema de bots del fork. Estado: **actual**.
> Documentos relacionados:
> - Voucher: [`vouchers.md`](./vouchers.md) · Voice Orders: [`voice-orders.md`](./voice-orders.md)
> - Históricos: [`archive/README.md`](./archive/README.md)

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

El refactor planificado en `archive/refactor-chatbot.md` está incompleto. La
arquitectura actual (regex + LLM monolítico) iba a ser reemplazada por módulos
separados (`order-parser`, `pricing-engine`, `cart-state`, `conversation-flow`,
`llm-responder`, `handoff-rules`) pero la integración no se completó. Además,
**Voice Orders** ya cubre la mayor parte del flujo de pedidos (ver
[`voice-orders.md`](./voice-orders.md)), por lo que reactivar este bot es
redundante hasta que se decida lo contrario.

### Base de datos (Supabase migrations)

| Migration | Tabla/Columna | Propósito |
|-----------|---------------|-----------|
| `032_chatbot_logs.sql` | `chatbot_logs` | Traza de auditoría |
| `033_order_context.sql` | `conversations.order_context` (JSONB) | Estado del carrito |
| `034_chatbot_pending_batches.sql` | `chatbot_pending_batches` | Debounce de 8s para mensajes fragmentados |

---

## 2. Voice Orders / Bot de pedidos (ACTIVO)

**Estado:** ✅ Activo — con UI en `/bot-beta`

**Propósito:** Toma pedidos por voz (audio) o texto vía WhatsApp, transcribe, parsea, resuelve precios a través de FacBal API y crea presupuestos/facturas.

> Documento dedicado con estado actual + mejoras pendientes:
> **[`voice-orders.md`](./voice-orders.md)**

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

## 6. Orden de Dispatch en Webhook

```
POST /api/whatsapp/webhook
  │
  ├── Template lifecycle → handleTemplateWebhookChange()
  ├── Status updates → handleStatusUpdate()
  │
  ├── ⚡ BOT MULTI-TURN (interactive replies) → interceptado ANTES de Flows
  │     Tap a botones [✅]/[✏️]/[❌] de gastos (stage=confirming) o
  │     asistencia (awaitingCorrection) → se marca como consumido y el
  │     flow runner / automaciones / AI reply no lo ven
  │
  ├── 🥇 FLOWS ENGINE → dispatchInboundToFlows()
  │     Si consume → suprime automatizaciones + AI reply + extractor
  │
  ├── 🥈 AUTOMATIONS → runAutomationsForTrigger()
  │
  ├── 🥉 AI AUTO-REPLY → dispatchInboundToAiReply()
  │     Solo si NO fue consumido por flow
  │
  ├── VOUCHER → processVoucherMessage()
  │     Solo imágenes/documentos de pago de clientes (fire-and-forget).
  │     Las respuestas de texto a comprobantes pendientes y los pendingTexts
  │     se manejan en el bloque voucher del webhook, NO vía el extractor.
  │
  ├── EXTRACTOR UNIFICADO (LLM) → extractBotMessage()
  │     Un solo call LLM por texto devuelve intent + campos + faltan_campos
  │     + dudoso (src/lib/bot-llm/). Recibe el contexto multi-turn de los
  │     bots para resolver respuestas cortas. Ante fallo/timeout/JSON
  │     inválido cae a fallbackExtract() (regex, confianza baja).
  │
  │     Dispatch por intent (un solo handler):
  │       · hasPendingExpense/hasPendingAttendance → handler del bot pendiente
  │       · gasto → handleExpenseMessage(extraction)
  │       · asistencia_* → handleAttendanceMessage(extraction)
  │       · voucher → se consume sin handler (grieta corregida: ya NO lo
  │         captura expense ni voice)
  │       · pedido/factura (confianza ≠ baja) → handleVoiceText()
  │       · otro / confianza baja → gates regex de seguridad (igual que antes)
  │
  ├── VOICE AUDIO → handleVoiceAudio()
  │     Solo audio de pedidos (fire-and-forget)
  │
  ├── VOICE TEXT → handleVoiceText()
  │     Solo texto de pedidos no consumido por flow (fire-and-forget)
  │
  └── WEBHOOK FAN-OUT → dispatchWebhookEvent()
```

> **Implementado (2026-08):** router unificado por LLM con confianza de 3
> niveles (`alta`/`media`/`baja`) y extracción estructurada por bot. Ver
> [`plan-bot-llm-unificado.md`](./plan-bot-llm-unificado.md).


---

## 7. Conexión con backend_gal (FacBal API)

**URL:** `https://api-bastidores.onrender.com`
**Auth:** `X-API-Key` header (desde `FACBAL_API_KEY` env var)
**Cliente:** `src/lib/facbal/client.ts`

### Endpoints consumidos

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

## 9. Resumen de IA Usada

| Sistema | Proveedor | Modelo | Propósito |
|---------|-----------|--------|-----------|
| Chatbot (disabled) | OpenRouter | `google/gemini-2.5-flash-lite` | Detección de intención + generación de respuesta |
| Voice Orders | OpenRouter | `openai/whisper-1` | Transcripción de audio |
| Voice Orders | OpenRouter | `google/gemini-2.5-flash-lite` | Parseo de pedidos |
| Voucher | OpenRouter | `google/gemini-2.5-flash` | Extracción de datos de comprobantes (visión) |
| Expense Bot | OpenRouter | `openai/whisper-1` | Transcripción de audio de gastos |
| Expense Bot | OpenRouter | `google/gemini-2.5-flash-lite` | Parseo de gastos por texto |
| Expense Bot | OpenRouter | `google/gemini-2.5-flash` | Extracción de datos de comprobantes de gasto (visión) |
| AI Auto-Reply | OpenAI/Anthropic | Configurable por cuenta | Respuestas automáticas |

---

## 10. Expense Bot / Gastos (ACTIVO)

**Estado:** ✅ Activo — registro de egresos multimodal desde WhatsApp.

**Propósito:** Permitir registrar cualquier egreso de la fábrica/negocio directamente desde WhatsApp (texto, audio, imagen o PDF) y mantener los datos sincronizados entre wacrm, backend_gal y galv2-tauri (FacGal).

### Principios de diseño

1. **No se borran datos existentes.** Se usan tablas nuevas (`expense_categories`, `expenses` en backend_gal) y se migró el histórico desde `movimientos_proveedor` y `pagos_empleados` sin eliminarlos.
2. **Tablas de proveedores y empleados se mantienen.** `proveedores` y `empleados` siguen siendo la fuente de verdad de esas entidades. `movimientos_proveedor` y `pagos_empleados` se vinculan con `expenses` mediante `expense_id`.
3. **Categorías dinámicas.** El bot puede crear categorías automáticamente si no existen y avisar al usuario.
4. **Disponible para todos los números.** No hay restricción de autorización por número.
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
