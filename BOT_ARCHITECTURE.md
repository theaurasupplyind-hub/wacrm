# Arquitectura de Bots — wacrm

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

### Flujo

```
Mensaje WhatsApp
  ↓
POST /api/whatsapp/webhook
  ↓
processMessage()
  ↓
debouncedChatMessage() ← 8s debounce vía chatbot_pending_batches
  ↓
processChatMessage() ← 🔴 CHATBOT_ENABLED=false → return
```

### Pipeline (si estuviera activo)

```
1. shouldHardHandoff(text) → regex para logística/pagos/quejas → deriva inmediatamente
2. getPendingGreeting() → verifica si usuario saludó y fue ignorado
3. Carga contexto (order_context) + últimos 15 mensajes
4. extractAction() → LLM extrae intención (add_to_cart, confirm_order, etc.)
5. Si extracción falla → detectIntent() → regex fallback
6. Ejecuta acción (precios, carrito, etc.) vía FacBal API
7. callOpenRouter() → genera respuesta final con CHAT_SYSTEM_PROMPT
8. Envía reply a WhatsApp
```

### Por qué está deshabilitado

El refactor descrito en `planrefactorbot.md` está incompleto. La arquitectura actual (regex + LLM monolítico) está siendo reemplazada por módulos separados (`order-parser`, `pricing-engine`, `cart-state`, `conversation-flow`, `llm-responder`, `handoff-rules`) pero la integración no se ha completado.

### Base de datos (Supabase migrations)

| Migration | Tabla/Columna | Propósito |
|-----------|---------------|-----------|
| `032_chatbot_logs.sql` | `chatbot_logs` | Traza de auditoría |
| `033_order_context.sql` | `conversations.order_context` (JSONB) | Estado del carrito |
| `034_chatbot_pending_batches.sql` | `chatbot_pending_batches` | Debounce de 8s para mensajes fragmentados |

---

## 2. Voice Orders / Bot Beta (ACTIVO)

**Estado:** ✅ Activo — con UI en `/bot-beta`

**Propósito:** Toma pedidos por voz (audio) o texto vía WhatsApp, transcribe, parsea, resuelve precios a través de FacBal API y crea presupuestos/facturas.

### Archivos clave

| Archivo | Rol |
|---------|-----|
| `src/lib/voice-orders/index.ts` | Entry point: `processVoiceOrder()`, `processTextOrder()` |
| `src/lib/voice-orders/types.ts` | Tipos: `ParsedOrder`, `VoiceOrderResult`, etc. |
| `src/lib/voice-orders/transcribe.ts` | Transcripción de audio vía OpenRouter Whisper |
| `src/lib/voice-orders/parse-order.ts` | Parseo LLM de texto a pedido estructurado |
| `src/lib/voice-orders/execute-order.ts` | Pipeline de resolución: cliente → items → precios → factura |
| `src/app/api/bot-beta/run/route.ts` | REST endpoint para texto |
| `src/app/api/bot-beta/voice-run/route.ts` | REST endpoint para audio (FormData) |
| `src/app/(dashboard)/bot-beta/page.tsx` | UI beta con chat + audio + debug panel |

### Flujo (Audio WhatsApp)

```
Mensaje de Audio WhatsApp
  ↓
processMessage() webhook
  ↓
handleVoiceAudio()
  ↓
processVoiceOrder()
  ├── 1. transcribeAudio() → OpenRouter Whisper (openai/whisper-1)
  ├── 2. parseOrder() → OpenRouter LLM (gemini-2.5-flash-lite)
  │       → {tipo, cliente_nombre, items, variante_respuesta}
  ├── 3. runPipeline()
  │       ├── searchOrCreateClient() → FacBal API
  │       ├── resolveItems() → FacBal suggestPrice (por item)
  │       ├── priceItems() → FacBal bulkPrice
  │       └── createPresupuesto() → FacBal createInvoice (si commit=true)
  └── 4. sendVoiceResponse() → WhatsApp reply
```

### Flujo (Texto WhatsApp)

```
Mensaje de Texto WhatsApp (no consumido por Flows Engine)
  ↓
processMessage() webhook
  ↓
handleVoiceText()
  ↓
processTextOrder() → mismo pipeline (salta transcripción)
```

### Soporte multi-turno

- Si un item tiene múltiples variantes → pregunta al usuario, guarda estado en `voice_context`
- Si falta nombre de cliente → pregunta, guarda en `voice_context`
- `commit=false` (default) → devuelve preview sin crear factura

### Base de datos

| Migration | Tabla/Columna | Propósito |
|-----------|---------------|-----------|
| `035_voice_context.sql` | `conversations.voice_context` (JSONB) | Estado entre mensajes (variantes pendientes, client name, invoice) |

---

## 3. Voucher Processing (ACTIVO)

**Estado:** ✅ Activo

**Propósito:** Cuando un cliente envía imagen/PDF de un comprobante de pago, extrae los datos vía IA, los empareja con facturas pendientes en FacBal y registra el pago automáticamente.

### Archivos clave

| Archivo | Rol |
|---------|-----|
| `src/lib/ai/voucher-pipeline.ts` | Orchestrador del pipeline completo |
| `src/lib/ai/voucher-extraction.ts` | Llamada OpenRouter multimodal (gemini-2.5-flash) |
| `src/lib/ai/voucher-matching.ts` | Matching determinista (±$50 tolerancia) |

### Flujo

```
Imagen/PDF WhatsApp
  ↓
processMessage() webhook → bgTasks.push(processVoucherMessage())
  ↓
processVoucherMessage()
  ├── 1. Send ACK: "Recibimos tu comprobante..."
  ├── 2. downloadMedia() → Meta API
  ├── 3. extractVoucherData() → OpenRouter Gemini Vision
  │       → {monto, fecha, referencia, banco}
  ├── 4. getFacturasPendientes(telefono) → FacBal API
  ├── 5. matchVoucher()
  │       ├── matched → registrarPago() → FacBal POST /payments
  │       ├── ambiguous → pregunta al usuario
  │       └── no_match → deriva a humano
  ├── 6. Save to voucher_extractions (audit)
  └── 7. Send final response
```

### Base de datos

| Migration | Tabla | Propósito |
|-----------|-------|-----------|
| `031_voucher_extractions.sql` | `voucher_extractions` | Auditoría de cada extracción |

---

## 4. Flows Engine (ACTIVO)

**Estado:** ✅ Activo — Feature nativo de wacrm

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

**Estado:** ✅ Activo — Configurable por cuenta (bring-your-own-key)

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
  ├── 🥇 FLOWS ENGINE → dispatchInboundToFlows()
  │     Si consume → suprime automatizaciones + AI reply + Voice Orders
  │
  ├── 🥈 AUTOMATIONS → runAutomationsForTrigger()
  │
  ├── 🥉 AI AUTO-REPLY → dispatchInboundToAiReply()
  │     Solo si NO fue consumido por flow
  │
  ├── VOUCHER → processVoucherMessage()
  │     Solo imágenes/documentos de pago de clientes (fire-and-forget)
  │
  ├── EXPENSE BOT → processExpenseMessage()
  │     Texto, audio, imagen o documento con intención de gasto
  │     Disponible para todos los números (fire-and-forget)
  │
  ├── VOICE AUDIO → handleVoiceAudio()
  │     Solo audio de pedidos (fire-and-forget)
  │
  ├── VOICE TEXT → handleVoiceText()
  │     Solo texto de pedidos no consumido por flow (fire-and-forget)
  │
  └── WEBHOOK FAN-OUT → dispatchWebhookEvent()
```

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

### Endpoints que backend_gal debe exponer

Basado en `planintegracion.md` y el código:

- `GET /invoices/pending-by-phone?telefono=` — facturas pendientes por teléfono
- `POST /payments` — registrar un pago
- `GET /clients` — listar clientes (con búsqueda por nombre)
- `POST /clients` — crear cliente
- `GET /products/search?q=` — búsqueda de productos
- `GET /products/suggest-price?q=` — sugerencia de precio
- `POST /products/bulk-price` — precio por lote
- `GET /price-list-images` — listar imágenes de listas de precio
- `GET /price-list-images/{id}/view` — ver imagen de lista de precio
- `POST /invoices` — crear factura/presupuesto
- `GET /providers` / `POST /providers` / `POST /providers/movements` — proveedores y movimientos
- `GET /employees` / `POST /employees/payments` — empleados y pagos
- `GET /expense-categories` / `POST /expense-categories` — categorías de gasto
- `POST /expenses` / `GET /expenses` / `GET /expenses/summary` — gastos

---

## 8. Conexión con galv2-tauri

**Relación:** `galv2-tauri` es una **aplicación de escritorio Tauri** (Svelte 5 + Rust) independiente que **comparte el mismo `backend_gal`** (FacBal API). No se conecta directamente a `wacrm`.

### Puntos de integración

- Misma base de datos PostgreSQL (NeonDB) compartida vía `backend_gal`
- `build-invoice-payload.ts:30` — comentario referencia que `buildItemDescription` genera descripciones "like galv2-tauri uses"
- `voice-orders-pendientes.md:25` — menciona agregar pantalla de confirmación en `galv2-tauri` antes de enviar pedidos a WhatsApp
- Ambos sistemas comparten el mismo API key para `backend_gal`

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

## 10. Archivos Clave — Mapa Rápido

```
src/
├── lib/
│   ├── ai/
│   │   ├── chatbot.ts              # Chatbot Bastidores (DISABLED)
│   │   ├── chatbot-logger.ts        # Logger del chatbot
│   │   ├── cart-state.ts            # Estado del carrito
│   │   ├── conversation-flow.ts     # Máquina de estados
│   │   ├── handoff-rules.ts         # Reglas de derivación
│   │   ├── build-invoice-payload.ts # Payload para crear factura
│   │   ├── voucher-pipeline.ts      # Pipeline de voucher (ACTIVE)
│   │   ├── voucher-extraction.ts    # Extracción de datos vía IA
│   │   ├── voucher-matching.ts      # Matching de voucher con factura
│   │   ├── auto-reply.ts            # AI Auto-Reply dispatch
│   │   ├── generate.ts              # Generador de respuestas AI
│   │   └── providers/               # Proveedores de IA
│   ├── voice-orders/
│   │   ├── index.ts                 # Entry point (ACTIVE)
│   │   ├── types.ts                 # Tipos
│   │   ├── transcribe.ts            # Transcripción Whisper
│   │   ├── parse-order.ts           # Parseo LLM
│   │   └── execute-order.ts         # Pipeline FacBal
│   ├── expenses/
│   │   ├── index.ts                 # Entry point: processExpenseMessage()
│   │   ├── types.ts                 # Tipos: ParsedExpense, ExpenseCategory
│   │   ├── parse-expense.ts         # Parser de texto a gasto estructurado
│   │   ├── transcribe-expense.ts    # Reutiliza Whisper para audio
│   │   ├── extract-expense.ts       # Reutiliza Gemini para imagen/PDF
│   │   ├── execute-expense.ts       # Pipeline FacBal: categoría/proveedor/empleado
│   │   ├── confirm-expense.ts       # Envía resumen y botones por WhatsApp
│   │   ├── fuzzy-match.ts           # Match categorías/proveedores/empleados
│   │   └── context.ts               # Estado multi-turno
│   ├── facbal/
│   │   └── client.ts                # Cliente API backend_gal
│   └── flows/
│       ├── engine.ts                # Motor de flujos
│       └── meta-send.ts             # Envío WhatsApp
├── app/
│   ├── api/
│   │   ├── whatsapp/webhook/route.ts # Webhook principal
│   │   ├── bot-beta/run/route.ts     # REST Voice Orders (texto)
│   │   └── bot-beta/voice-run/route.ts # REST Voice Orders (audio)
│   └── (dashboard)/bot-beta/         # UI del Bot Beta
```

---

## 11. Expense Bot / Gastos (PLAN)

**Estado:** ⏳ Planificado — nuevas tablas y bot multimodal desde WhatsApp.

**Propósito:** Permitir registrar cualquier egreso de la fábrica/negocio directamente desde WhatsApp (texto, audio, imagen o PDF) y mantener los datos sincronizados entre wacrm, backend_gal y galv2-tauri (FacGal).

### Principios de diseño

1. **No se borran datos existentes.** Se crean tablas nuevas (`expense_categories`, `expenses`) y se migra el histórico desde `movimientos_proveedor` y `pagos_empleados` sin eliminarlos.
2. **Tablas de proveedores y empleados se mantienen.** `proveedores` y `empleados` siguen siendo la fuente de verdad de esas entidades. `movimientos_proveedor` y `pagos_empleados` se vinculan con `expenses` mediante `expense_id`.
3. **Categorías dinámicas.** El bot puede crear categorías automáticamente si no existen y avisar al usuario.
4. **Disponible para todos los números.** Por ahora no hay restricción de autorización; cualquier número de WhatsApp puede registrar gastos.
5. **Reutilizar infraestructura existente.** El bot transcribe audio con Whisper (mismo modelo de Voice Orders) y lee comprobantes con Gemini Vision (mismo modelo de Voucher).

### Modelos de datos en backend_gal

#### `expense_categories`

| Campo | Tipo | Notas |
|-------|------|-------|
| `id` | int | PK |
| `name` | string | Nombre visible (ej: "Luz", "Sueldos y salarios") |
| `slug` | string | Identificador único normalizado |
| `color` | string | Color para UI y reportes |
| `icon` | string | Emoji o nombre de icono |
| `type` | string | `operativo`, `administrativo`, `personal`, `logistica`, `otros` |
| `is_default` | bool | Si viene del seed inicial |
| `created_by` | int? | Usuario o null si viene del sistema |
| `created_at` | datetime | |
| `deleted_at` | datetime? | Soft delete |

#### `expenses`

| Campo | Tipo | Notas |
|-------|------|-------|
| `id` | int | PK |
| `date` | string | YYYY-MM-DD |
| `amount` | float | Monto del gasto |
| `description` | string | Descripción del gasto |
| `category_id` | int | FK a `expense_categories` |
| `provider_id` | int? | FK opcional a `proveedores` |
| `employee_id` | int? | FK opcional a `empleados` |
| `payment_method` | string | `efectivo`, `transferencia`, `debito`, `credito`, `mercado_pago`, etc. |
| `reference` | string? | Número de comprobante, remito, factura |
| `source` | string | `whatsapp`, `facgal`, `manual`, `bot` |
| `created_by_user_id` | int? | Usuario de wacrm/FacGal si aplica |
| `created_by_contact_id` | int? | Contacto de WhatsApp si aplica |
| `status` | string | `pending`, `confirmed`, `cancelled` |
| `raw_input` | string? | Texto transcrito o datos crudos del bot |
| `media_url` / `media_id` | string? | Foto/PDF del comprobante si aplica |
| `created_at` | datetime | |
| `updated_at` | datetime | |
| `deleted_at` | datetime? | Soft delete |

#### Vinculación con tablas existentes

Se agrega `expense_id` (nullable) a:
- `movimientos_proveedor`
- `pagos_empleados`

Cuando un gasto apunta a un proveedor o empleado, se crea el `expense` y el movimiento específico vinculado, permitiendo que FacGal siga mostrando balances, saldos y sueldos como hoy.

### Categorías predeterminadas (seed)

| Categoría | Tipo |
|-----------|------|
| Luz | administrativo |
| Agua | administrativo |
| Internet | administrativo |
| Alquiler | administrativo |
| Gas (servicio) | administrativo |
| Limpieza | administrativo |
| Seguro | administrativo |
| Impuestos | administrativo |
| Contabilidad / Asesoría | administrativo |
| Compra a proveedor | operativo |
| Pago a proveedor | operativo |
| Materia prima / Insumos | operativo |
| Herramientas y repuestos | operativo |
| Mantenimiento de máquinas | operativo |
| Consumibles de taller | operativo |
| Sueldos y salarios | personal |
| Adicionales y bonificaciones | personal |
| Viáticos del personal | personal |
| Flete | logistica |
| Envío / Correo | logistica |
| Transporte | logistica |
| Combustible | logistica |
| Comida / Viandas | otros |
| Gastos varios | otros |
| Retiro de socios | otros |
| Marketing / Publicidad | otros |
| Subscripciones / Software | otros |

> Si el bot detecta una categoría que no existe, la crea automáticamente (`is_default = false`) y responde: *"Creé la categoría 'Capacitación' automáticamente. Si querés cambiarla, escribí 'corregir categoría'"*.

### Migración de datos históricos

| Origen | Destino | Acción |
|--------|---------|--------|
| `movimientos_proveedor` tipo `PAYMENT` | `expenses` categoría `Pago a proveedor` | Copiar amount, date, provider_id, description |
| `movimientos_proveedor` tipo `PURCHASE` | `expenses` categoría `Compra a proveedor` | Copiar amount, date, provider_id, description |
| `movimientos_proveedor` tipo `STOCK_IN` / `STOCK_OUT` | **No migrar** | Son movimientos de stock, no egresos |
| `pagos_empleados` | `expenses` categoría `Sueldos y salarios` | Copiar amount, date, employee_id, concepto/detalle |

Después de la migración, cada registro original se actualiza con `expense_id = expense.id`.

### Endpoints nuevos en backend_gal

| Método | Endpoint | Uso |
|--------|----------|-----|
| GET | `/expense-categories` | Listar categorías |
| POST | `/expense-categories` | Crear categoría (bot o FacGal) |
| PUT | `/expense-categories/:id` | Editar categoría |
| DELETE | `/expense-categories/:id` | Borrar lógico |
| POST | `/expenses` | Crear gasto |
| GET | `/expenses` | Listar gastos |
| GET | `/expenses/:id` | Ver gasto |
| PUT | `/expenses/:id` | Editar gasto |
| DELETE | `/expenses/:id` | Borrar lógico |
| GET | `/expenses/summary` | Resumen por período/categoría |
| POST | `/expenses/migrate` | Endpoint one-shot de migración histórica |

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

### Flujo del bot (WhatsApp)

```
Mensaje entrante (texto/audio/imagen/PDF)
  ↓
POST /api/whatsapp/webhook
  ↓
processExpenseMessage()
  ├── Texto     → parseExpense() → estructura de gasto
  ├── Audio     → transcribeExpense() → Whisper → parseExpense()
  ├── Imagen/PDF → extractExpense() → Gemini Vision → parseExpense()
  ↓
fuzzyMatch()
  ├── categoría: match por nombre; si no existe → crear automáticamente
  ├── proveedor: match por nombre; si no existe → ofrecer crear
  └── empleado: match por nombre; si no existe → ofrecer crear
  ↓
executeExpense()
  ├── Gasto general → POST /expenses
  ├── Gasto a proveedor → POST /expenses + POST /providers/movements
  └── Gasto a empleado → POST /expenses + POST /employees/payments
  ↓
confirmExpense()
  └── Resumen por WhatsApp + botones Confirmar/Corregir/Cancelar
  ↓
Guardar en expense_extractions (auditoría)
```

### Ejemplos de interacción

**Audio:**
> *"Pagué 18 mil de luz"*

Respuesta:
> ✅ Gasto registrado:
> 💰 $18.000,00
> 📁 Luz (categoría existente)
> 📝 Pago de luz
> 📅 17/07/2026

**Audio con proveedor:**
> *"Pagué 56 mil a proveedor Rosario"*

Respuesta:
> ✅ Pago registrado:
> 💰 $56.000,00
> 📁 Pago a proveedor
> 🏭 Proveedor: Rosario
> 📅 17/07/2026

**Categoría nueva automática:**
> *"Gasté 4.500 en capacitación"*

Respuesta:
> ✅ Gasto registrado:
> 💰 $4.500,00
> 📁 Capacitación (categoría creada automáticamente)
> 📝 Capacitación
> Si querés corregir la categoría, escribí "corregir categoría".

### Base de datos (Supabase migrations)

| Migration | Tabla/Columna | Propósito |
|-----------|---------------|-----------|
| `036_expense_categories.sql` | `expense_categories` | Categorías de gasto dinámicas |
| `037_expenses.sql` | `expenses` | Tabla principal de egresos |
| `038_expense_extractions.sql` | `expense_extractions` | Auditoría de cada extracción del bot |

### Notas de implementación

- El bot no requiere autorización por número en la primera versión.
- Se recomienda mantener `status = 'pending'` hasta que el usuario confirme, y luego pasar a `confirmed`.
- Los comprobantes de gasto se distinguen de los vouchers de pago de clientes por el contexto: el Voucher busca facturas pendientes; el Expense Bot busca registrar un egreso.
- FacGal (galv2-tauri) debe agregar una pantalla de gestión de categorías y un listado de gastos compartidos vía `/expenses`.

---

## 12. Mejoras Propuestas

### Corto plazo
1. **Módulo Expense Bot / Gastos** — registrar gastos desde WhatsApp por texto, audio, imagen y PDF, con categorías dinámicas e integración con proveedores/empleados de FacGal
2. **Reactivar chatbot Bastidores** — completar el refactor del `planrefactorbot.md`
3. **Unificar Voice Orders + Chatbot** — Voice Orders ya cubre gran parte del flujo del chatbot deshabilitado
4. **Agregar más tests** para voice-orders pipeline

### Mediano plazo
5. **Webhook de FacBal hacia wacrm** — en lugar de polling, que FacBal notifique cambios
6. **Sincronización bidireccional** entre wacrm y galv2-tauri para evitar conflictos
7. **Dashboard en galv2-tauri** para monitorear pedidos entrantes desde wacrm

### Largo plazo
8. **Manejo de cola de impresión** desde wacrm (actualmente solo en galv2-tauri Print Agent)
9. **Notificaciones push** desde wacrm a galv2-tauri para nuevos pedidos
