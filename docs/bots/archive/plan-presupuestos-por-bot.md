# Plan: Presupuestos por bot (motor de precios de galv2)

> **Estado:** ✅ **Implementado** (archivado). El motor de precios existe en
> `src/lib/precios/` (con tests) y el flujo de presupuestos en `src/lib/pedidos/`.
> Los gotchas de precios vigentes están en
> [`../decisiones-y-gotchas.md`](../decisiones-y-gotchas.md) §2.
> **Autor de la investigación:** sesión de diseño (2026-10).
> **Fuente de verdad actual:** [`../architecture.md`](../architecture.md) §6 y §12.
> Se conserva como registro de diseño; **no ejecutar como plan**.

## 1. Objetivo

Agregar al bot de WhatsApp la capacidad de **armar presupuestos** a partir de pedidos
escritos de forma confusa (medidas sueltas, listas, variantes al final), cobrando y
creando el documento de forma **determinística** con el **mismo motor de precios que usa
galv2-tauri** (`precios_referencia` + `pricing_rules`).

Alcance inicial: **bot-beta + webhook de producción**, **gateado por whitelist**
(uso interno, no público).

## 2. Decisiones cerradas

- **Motor de precios**: port fiel de `galv2-tauri/src/lib/utils/precios.ts` a TypeScript
  dentro de wacrm. Match **solo** contra `precios_referencia` y `pricing_rules`.
- **`bulk_price`** (backend_gal): queda **deprecado** — no se usa, no se borra, no se
  toca su lógica.
- **`chatbot.ts`** y sus helpers (`chatbot-logger.ts`, `conversation-flow.ts`,
  `handoff-rules.ts`, `cart-state.ts`, `build-invoice-payload.ts`): **deprecados**, no se
  borran en esta sesión. El código nuevo NO debe importarlos.
- **Documento**: se crea un **PRESUPUESTO** en `backend_gal` (visible/printable en
  galv2-tauri) **y** se renderiza la **tarjeta de WhatsApp de `receipt.ts`** y se envía
  por WhatsApp como imagen.
- **Flujo "asumir y corregir"**: el bot **nunca bloquea** con preguntas. Asume el mejor
  candidato, arma el presupuesto mostrando los supuestos, y el usuario corrige (todo
  junto o ítem por ítem). Recién crea el documento al **confirmar**.
- **Cliente**: por nombre en el mensaje; se asume del texto y se pide sólo si no hay
  ninguno al confirmar.
- **Defaults de galv2-tauri**: `envio=0`, `tipo_entrega='Retira'`, `estado_kanban='PEDIDO'`,
  `user_id=0`, `tipo='PRESUPUESTO'`.
- **Faltantes** (sin referencia en `precios_referencia`): se excluyen del total y se
  listan para corregir/cotizar a mano; el presupuesto se crea igual con los cotizables.

### Modelo de catálogo (verificado en código)

- `precios_referencia`: productos base con medidas "estándar" formato `A x B`
  (ej. `BASTIDOR 150x150 Sin Tela = 105000`). Son las medidas cotizadas.
- Medidas derivadas (`154x150`, `157x152`, …) no están cargadas: se *snap-ean* a la
  referencia con `roundDim` (múltiplo de 10; unidad 0–3 baja, 4–9 sube) y, si no hay
  exacto, por **perímetro más cercano**. Lógica: `precios.ts:597` (`roundDim`),
  `precios.ts:277` (`findRefPrice`).
- `pricing_rules`: "productos diferentes" derivados de un base (Pintura = Sin Tela +10%,
  Tapacanto = precio de Lienzo Profesional, etc.) con `operation`
  (direct/percentage/fixed/override), `conditions` (lado_menor/mayor/grosor) y `rounding`.

### Motor real de galv2

El motor autoritativo es **`suggestPrice(query, refsToProductos(preciosReferencia),
pricingRules)`** (`precios.ts:655`), lo usa `Facturacion.svelte:704,728`. El usuario elige
una `PriceSuggestion` y `selectSuggestion` guarda `sug.description` como descripción del
ítem y `sug.price` como `precio_unitario` (`Facturacion.svelte:688-690`). `evaluateRules`
es sólo el debug del modal de reglas.

> ⚠️ **No encadenar** `suggest-price` (backend) con `bulk-price`: el backend
> `_process_reglas` ya aplica el `+10%` hardcodeado de pintura y `_apply_pricing_rules`
> volvería a aplicar la `pricing_rule` → **doble conteo**. El bot usa un único motor
> (el port de `precios.ts`).

> ⚠️ galv2-tauri **no** llama a `bulk-price` ni a `suggest-price`: hace el pricing
> client-side en `precios.ts`. El backend `bulk-price` es un espejo imperfecto
> (traducción hardcodeada de sólo PINTURA/TAPACANTO, acumula reglas, % sobre base, etc.),
> por eso se deprecó y se porta el motor real.

## 3. Flujo

```
texto WhatsApp (whitelist)
 → extractBotMessage → intent "pedido" (o pending order_context)
 → decideDispatch → dispatchedTo='pedido'
 → processPedidoMessage:
      parseo LLM → resolve-items (motor portado, ASUME top)
      → resumen con supuestos → confirmar
      corrección (variante/categoría/medida/precio) → recalcula
      confirmar → createInvoice(PRESUPUESTO) → render receipt → engineSendMedia
```

## 4. Fases

### Fase 1 — Motor portado (`src/lib/precios/`)

**Crear:**

- `src/lib/precios/types.ts` — copiar `PrecioReferencia`, `PricingRule`, `PriceSuggestion`,
  `ParsedQuery`, `RuleCondition` desde `galv2-tauri/src/lib/types/index.ts`
  (`PricingRule` en `:481`).
- `src/lib/precios/engine.ts` — port literal de
  `galv2-tauri/src/lib/utils/precios.ts`:
  - `normalizeText` (`:15`), `extractDims` (`:26`), `getBaseAndDims` (`:39`),
    `parseQuery` (`:46`), `singularize` (`:69`), `capFirst`, `ruleMatchScore` (`:91`),
    `ruleMatchesQuery` (`:165`), `buildSuggestionDesc` (`:177`), `findRefPrice` (`:277`),
    `evaluateRules` (`:323`, opcional), `smartProductSearch` (`:518`),
    `refsToProductos` (`:568`), `roundPrice` (`:582`), `roundDim` (`:597`),
    `nearestStandard` (`:608`), `calcPriceByPerimeter` (`:621`), `suggestPrice` (`:655`).
- `src/lib/precios/index.ts` — barrel.
- `src/lib/precios/engine.test.ts` — fixtures con casos de galv2
  (`docs/bots/archive/refactor-chatbot.md:131-135`):
  - `"bastidor sin tela 42x141"` → snap `40x140`.
  - `"embastame una pintura 94x81"` → base `100x80` + regla pintura.
  - `"acrilico 94x81"` NO aplica pintura.
  - `"5 bastidores 60x40, 3 60x70, 1 90x10"` → 3 ítems con cantidades y faltante explícito.
  - Ambigüedad de variante: `"bastidor 60x40"` → múltiples variantes.
  - Medida sobre máximo: `"400x300"` → sin match exacto y por encima de la máxima.

**Aceptación:** `npm run test -- precios` verde; el port no importa nada de `ai/chatbot`.

### Fase 2 — Accesores de datos (`src/lib/facbal/client.ts`)

- `getPreciosReferencia()` → `GET /precios-referencia` (`backend_gal/main.py:2516`).
- `getPricingRules()` → `GET /pricing-rules` (`backend_gal/pricing_rules.py:59`).
  `match_tokens` y `conditions` vienen como **string JSON** → parsear a array
  (referencia de parseo: `galv2-tauri/src/lib/screens/Facturacion.svelte:585-598`).
- `nextInvoiceNumber(prefix='F')` → `GET /invoices/next_number?prefix=F`
  (`backend_gal/main.py:3338`).
- Marcar `bulkPrice` y tipos `BulkPrice*` como `@deprecated` en JSDoc (no borrar).

**Aceptación:** `npx tsc --noEmit` sin errores nuevos; parseo de `match_tokens`/
`conditions` cubierto por un test unitario pequeño.

### Fase 3 — Módulo `src/lib/pedidos/`

#### 3.1 `types.ts`

`PedidoItem { cantidad, categoria, medida, variante, precio_unitario|null, faltante,
descripcion, regla_aplicada, asumido? }`;
`OrderContext { stage:'confirming', items, clienteNombre, total, faltantes[],
notaSupuestos[] }`.

#### 3.2 `parse-order.ts` (LLM, no calcula)

- `callOpenRouter` (`src/lib/ai/openrouter.ts:131`), `jsonMode`,
  `google/gemini-2.5-flash-lite`, temperatura baja.
- Salida: `{ cliente: string|null, items: { cantidad:number, texto:string }[] }`.
- El `texto` **conserva el vocabulario del usuario** ("sin tela", "lienzo profesional",
  "lona preparada", "doble 4cm", "pintura", "embastame", "tapacanto", "rollo 2x5", …)
  para que `ruleMatchScore` matchee.
- **Modificador final aplica a toda la lista:**
  `"56 x 78, 89 x 67, 67 x 56 sin tela"` → 3 ítems, todos `Sin Tela`.
- Reglas few-shot: `"dos más, 58x29, 184x95"` → 2 ítems (no 2× 58x29); `"N de X"` → N del
  mismo; separar por categoría/producto; no inventar precios.
- Medidas sin categoría → `categoria='BASTIDOR'`. Cantidades ("dos más", "N de X") y
  continuaciones ("2", "la 2") resueltas contra `order_context` pendiente.
- Fallback regex si el LLM falla (medidas `\d+x\d+`, cantidades por palabra, cliente
  "a/para <Nombre>").

#### 3.3 `resolve-items.ts` (determinístico — núcleo, **ASUME**)

Por cada `item.texto`: `sugerencias = suggestPrice(texto, refsToProductos(refs), rules)`.
Selección **sin preguntar**:

1. **Regla matchea** → precio de regla; si hay varias, tomar la primera (orden estable) y
   anotar las alternativas en `notaSupuestos`.
2. **Medida exacta** (dims redondeadas) con una sola variante → usar.
3. **Medida exacta con varias variantes** → asumir la **primera** (orden estable de
   variante) y anotar las otras en `notaSupuestos`.
4. **Candidatos por perímetro** (comportamiento galv2) → el más cercano; si hay varias
   variantes, asumir la primera.
5. **Medida > máxima de referencia** (dinámica; hoy `300x200`; comparar ladoMayor/ladoMenor)
   → asumir como provisional el **precio de la referencia más cara global** y marcarlo
   "a revisar".
6. **Sin ninguna referencia** → `faltante=true` (excluido del total), anotado para
   corregir a mano.

- Descripción final del ítem: `buildSuggestionDesc(texto, ruleName, rule)` cuando vino de
  regla; si no, la `descripcion` del ref ganador + medida pedida.
- **No** usar `calcPriceByPerimeter` para auto-precio (evitar estimaciones silenciosas).

**Aceptación:** tests cubren regla, ambigüedad de variante (asume primera, no pregunta),
varias reglas, medida > máxima (asume más cara global), faltante excluido.

#### 3.4 `context.ts`

`loadOrderContext` / `saveOrderContext` / `clearOrderContext` sobre
`conversations.order_context` (migración **033**, ya existe), mismo patrón que
`src/lib/expenses/context.ts`.

#### 3.5 `execute.ts`

- Cliente: `searchClients(nombre, telefono)`; si no existe, `createClient` al confirmar.
- Número: `nextInvoiceNumber('F')` → derivar `P-XXXXX`
  (`galv2-tauri/src/lib/screens/Facturacion.svelte:1138-1144`).
- `createInvoice` (`src/lib/facbal/client.ts:496`): `numero_presupuesto=P-…`,
  `tipo:'PRESUPUESTO'`, `fecha` DD/MM/YYYY, `cliente_*`,
  `items:[{cantidad, descripcion, precio_unitario, total}]`, `total` (solo cotizables),
  `envio:0`, `user_id:0`, `tipo_entrega:'Retira'`, `estado_kanban:'PEDIDO'`.

#### 3.6 `receipt-image.tsx`

Componente **satori/JSX** (flexbox, **sin `<table>`**) que replica la tarjeta de
`galv2-tauri/src/lib/utils/receipt.ts` (400px: header "BASTIDORES GAL", nº presupuesto,
fecha, cliente/tel, filas de ítems, subtotal, entrega "Retira", TOTAL, footer
"Presupuesto"). Exporta el elemento para `ImageResponse`.

#### 3.7 `index.ts` — `processPedidoMessage(args)`

Firma espejo de `processExpenseMessage` (`src/lib/expenses/index.ts:1029`):
`{db, text, accountId, userId, conversationId, contactId, senderPhone, senderName,
accessToken, messageId}` → `{handled, text, createdInvoice?, imageUrl?}`.

- **Sin pending:** `parse-order` → `resolve-items` (asume) → guardar
  `order_context{stage:'confirming',...}` → responder **resumen** con total, ítems,
  supuestos ("asumí: Sin Tela") y faltantes → "¿confirmás? (sí / corregí lo que quieras)".
- **Correcciones** (texto del usuario): re-parsear contra el `order_context` (cambios por
  ítem: "el 2 es lienzo profesional", "el último sin tela", "el 3 ponele 50000", "sacá el
  2"), recalcular y volver a mostrar. Acepta corrección **agrupada o por ítem**.
- **Confirmar** ("sí/confirmar/dale"): `execute.ts`; limpiar `order_context`; devolver
  `createdInvoice` + `imageUrl`.
- **Cancelar** ("no/cancelar"): `clearOrderContext`, responder cancelado.

### Fase 4 — Ruta de imagen

- `src/app/api/presupuesto-image/[id]/route.tsx` (leer docs Next 16 primero): `GET` →
  trae la factura por id (facbal client / `GET /invoices?...`) → `ImageResponse` de
  `receipt-image.tsx` (PNG, 400px de ancho).
- Envío: `engineSendMedia` (`src/lib/flows/meta-send.ts:169`) con
  `link = ${NEXT_PUBLIC_APP_URL | NEXT_PUBLIC_SITE_URL}/api/presupuesto-image/${id}`.
  Fallback: enviar texto con nº + total si falla el render o el envío.

### Fase 5 — Intent + router ("no preguntar de más")

Reglas de clasificación, en orden de prioridad dentro de `decideDispatch`:

1. **Dominio explícito gana:** marcadores de gasto/voucher/asistencia/pago → ese intent,
   **nunca** pedido (reusar `looksLikeExpense`, `looksLikeAttendance`,
   `classifyPaymentIntent` y el extractor LLM).
2. **Listas de medidas → pedido:** uno o más `\d+\s*[xX×*]\s*\d+` (con o sin producto/
   variante) ⇒ `pedido`, aunque no digan "presupuesto/pedido". Ej:
   `56 x 78, 89 x 67, 67 x 56 sin tela` → `pedido`.
3. **Keywords de producto/pedido** (`presupuesto`, `cotizar`, `pedido`, `hacele a X`,
   `bastidor`, `lienzo`, `pintura`, `tapacanto`, `acrílico`, `circular`, `rollo`) →
   `pedido` si no hay dominio rival.
4. **Pending `order_context`** activo: medidas/cantidades/variantes/precios/nombres →
   continuación de pedido (multi-turn), sin re-clasificar.
5. Nada aplica → `otro`/`assistant`.

**Cambios:**

- `src/lib/bot-llm/types.ts:1` — agregar `'pedido'` a `BotIntent`.
- `src/lib/bot-llm/extract-bot-message.ts` — `VALID_INTENTS` + reglas/few-shot del
  `EXTRACT_PROMPT`:
  - `"56 x 78, 89 x 67, 67 x 56 sin tela"` → `pedido`.
  - `"compré 3 bastidores 60x40 a Joaquín por 30000"` → `gasto` (no pedido).
  - `"Mathias pago en efectivo"` → `voucher`.
  - `"llegó juan 8:30"` → `asistencia_llegada`.
- `src/lib/bot-llm/fallback.ts` — `looksLikePedido(text)`: verdadero si hay medidas
  `\d+x\d+` (una o más) y no matchea expense/attendance/payment; también keywords de
  pedido sin monto/proveedor.
- `src/lib/bot/router.ts` — nuevo `DispatchedTo='pedido'`; en `decideDispatch`:
  prioridad a `hasPendingOrder` (respuestas cortas) y `intent==='pedido'`; el dominio
  explícito gana si viene con confianza alta/media.
- `src/lib/bot-llm/context.ts` — serializar `order_context` pendiente para el extractor.

### Fase 6 — Wiring webhook + bot-beta

- `src/app/api/whatsapp/webhook/route.ts`: `loadOrderContext(conversation.id)`,
  `hasPendingOrder`, sumar `'order'` a `pendingDomains`, `case 'pedido'` →
  `processPedidoMessage` (patrón `handleExpenseMessage` en `:661`) + envío texto/imagen;
  registrar en `router_logs.debug_info`.
- `src/lib/bot-beta/unified-handler.ts`: si `decision.dispatchedTo==='pedido'` →
  `processPedidoMessage` usando `dummyConversationId`/`accountId`; si no hay Supabase,
  modo preview sin escribir.

### Fase 7 — Prompt del asistente y tool opcional

- `src/lib/bot-assistant/prompts.ts` — agregar capacidad "armar presupuestos/pedidos" +
  regla de **asumir y ofrecer corrección** (no bloquear preguntando) + confirmar antes de
  crear.
- (Opcional) `src/lib/bot-assistant/tool-registry.ts` — tool `cotizar_pedido(texto)` que
  llame a `resolve-items` (read-only) para el camino agente.

### Fase 8 — Verificación

- `npm run test`, `npx tsc --noEmit`, `npm run lint` (todo verde).
- Manual en `/bot-beta`:
  - pedido claro;
  - lista de medidas (`56 x 78, 89 x 67, 67 x 56 sin tela`);
  - corrección por ítem;
  - medida > máxima (asume más cara global + flag);
  - confirmar → presupuesto + imagen WhatsApp.
- Verificar que no haya imports de `bulkPrice` backend, `suggestPrice` backend, ni
  `ai/chatbot`.

## 5. Fuera de alcance (NO hacer)

- No borrar ni alterar `bulk_price` (`backend_gal/main.py:3150`, `pricing_rules.py`,
  `BulkPrice*`).
- No borrar `src/lib/ai/chatbot.ts` ni `chatbot-logger.ts`, `conversation-flow.ts`,
  `handoff-rules.ts`, `cart-state.ts`, `build-invoice-payload.ts` (deprecados; limpieza
  en otra sesión).
- No tocar la página `/(dashboard)/chatbot-debug` ni `/api/chatbot/logs` ni las
  migraciones `032`/`034`.
- No modificar el flujo de Voucher / Flows / Gastos / Asistencia.

## 6. Riesgos y notas

- `POST /invoices` sobrescribe `numero_factura` con el atómico; `P-XXXXX` deriva del peek
  de `next_number` (mismo comportamiento que galv2). El comprobante muestra el
  `numero_presupuesto`.
- satori (`@vercel/og`) no soporta `<table>` → la tarjeta se porta a flexbox (equivalente
  visual, no pixel-perfect).
- La distinción `pedido` vs `gasto` es el punto más sensible del prompt; cubrir con
  few-shot + fallback regex.
- Tie-breakers de "asumir" (variante por orden estable; provisional de medida excedida =
  referencia más cara global) son **defaults ajustables**. Si el negocio define otro
  default (ej. variante "Sin Tela" como preferida), setearlo en `resolve-items.ts`.
- Validar el umbral de "medida excedida" (lado/perímetro) contra los datos reales del
  catálogo al implementar.
- El motor portado itera todas las refs por línea; con catálogos grandes conviene evaluar
  un cache liviano de `precios_referencia`/`pricing_rules` por request.

## 7. Referencias de código

- Motor real galv2: `galv2-tauri/src/lib/utils/precios.ts`; consumo en
  `galv2-tauri/src/lib/screens/Facturacion.svelte:704,728,688-690`.
- Tarjeta WhatsApp: `galv2-tauri/src/lib/utils/receipt.ts`.
- Plantillas PDF (referencia, no se replican): `galv2-tauri/invoice_template.html` (+`_2`,
  `_3`), render Tauri en `galv2-tauri/src-tauri/src/pdf.rs`.
- Backend: `backend_gal/main.py` (`/products/bulk-price:3150`, `/products/suggest-price:2826`,
  `/invoices:3704`, `/invoices/next_number:3338`, `/precios-referencia:2516`),
  `backend_gal/pricing_rules.py`.
- Cliente FacBal: `wacrm/src/lib/facbal/client.ts`.
- Asistente/pedidos: `wacrm/src/lib/bot-assistant/`, `wacrm/src/lib/bot-llm/`,
  `wacrm/src/lib/bot/router.ts`, `wacrm/src/lib/expenses/` (patrón a seguir),
  `wacrm/src/app/api/whatsapp/webhook/route.ts`.
