# Plan: Extractor unificado (LLM) — intents + parseo de bots

> Documento para un próximo agente. Implementa un **extractor único por LLM** que
> reemplaza al clasificador de intenciones (`classifyIntent`) y a los parsers
> regex de texto de **asistencia** y **gastos**, con los regex como fallback.
> Estado: implementado (2026-08).
> Contexto: [`architecture.md`](./architecture.md) §6 (dispatch), §10 (gastos), §11 (asistencia),
> [`plan-mejora-gastos-asistencia.md`](./plan-mejora-gastos-asistencia.md) (fases A–D ya implementadas).

## Decisiones tomadas (confirmadas con el dueño)

- **Opción A — Extractor unificado**: un solo call LLM por mensaje de texto
  devuelve intent + campos estructurados + `faltan_campos` + `dudoso`.
- **Ir directo al extractor** (incluye arreglar las grietas de routing, no solo quick wins).
- **Pasar contexto multi-turn al LLM** (historial reciente + estado pendiente del bot)
  para que resuelva respuestas cortas ("juan", "8:30", "corregir").
- Los parsers regex actuales (`parse-attendance.ts`, `parse-expense.ts`) **quedan como
  fallback** ante fallo/timeout del LLM, y sus tests se mantienen.

---

## Cómo funciona hoy (estado relevado)

### Router de intenciones (`src/app/api/whatsapp/webhook/route.ts`, ~L1397-1470)

1. **Flows Engine** primero; si consume, se corta. Los taps a botones de los bots
   multi-turn se interceptan **antes** de `dispatchInboundToFlows`
   (`interactiveConsumed`, gastos `stage==='confirming'` y asistencia
   `awaitingCorrection`).
2. Si quedó libre el texto: **LLM classifier** `classifyIntent`
   (`src/lib/ai/intent-classifier.ts`, gemini-2.5-flash-lite, temp 0.1, jsonMode)
   → `{tipo: pedido|gasto|voucher|asistencia|factura|otro, confianza: alta|baja}`.
3. `confianza === 'alta'` → dispatch directo:
   - `gasto` → `handleExpenseMessage`
   - `asistencia` → `handleAttendanceMessage`
   - `pedido`/`factura` → `handleVoiceText` (si `!shouldSuppressVoiceOrder`)
   - **`voucher` NO tiene branch** → cae al fallback (grieta).
4. Si `baja`/`otro`/falló → **fallback regex**:
   - `looksLikeExpense` → expense; `looksLikeAttendance` → attendance; si no → voice.

### Parsers por bot

| Bot | Texto | Audio | Imagen/PDF |
|---|---|---|---|
| Expense | regex `parse-expense.ts` + fuzzy-match (`fuzzy-match.ts`) | Whisper → regex | Gemini multimodal → JSON (`extract-expense.ts`) |
| Attendance | regex `parse-attendance.ts` | — | — |
| Voucher | solo con contexto pendiente | — | Gemini multimodal → JSON (`voucher-extraction.ts`) |
| Voice Orders | **LLM estructurado** `parse-order.ts` (patrón a reutilizar) | Whisper → LLM | — |

- LLM ya se usa para: routing, órdenes, vouchers y gastos por imagen. Los únicos
  parsers **100% regex para texto** son asistencia y gastos.
- Infra LLM compartida: `callOpenRouter` (`src/lib/ai/openrouter.ts`, flash-lite,
  jsonMode, timeout 20s). `parseNumberSafe` reutilizable en `extract-expense.ts`.
- Estado multi-turn ya implementado: `attendance_context` (migración 044, fases B),
  `expense_context` (migración 036, stage `collecting`/`confirming`), `voucher_context`.

### Problemas / ambigüedades detectados

1. **Grieta `voucher`**: classifier puede devolver `voucher` alta pero no hay branch;
   `looksLikeExpense("transferí para la factura 001")` = true → **expense se lo come**.
2. **Fallback regex peligroso**: `looksLikeExpense("compré 3 bastidores 60x40")` = true →
   un pedido de cliente podría registrarse como gasto si el LLM falla o da confianza baja.
   `looksLikeAttendance("se fue la luz")` = true (keyword `se fue`).
3. **Classifier corre en cada texto**, incluso respuestas multi-turn; y se llama SIN
   historial (`classifyIntent(inboundText)`, no usa `contextText`).
4. **Confianza binaria** (alta/baja); sin escala media, sin retry, sin validación de esquema.
5. `voucher` texto solo se procesa con `hasPendingVoucher`; no hay entrada para intent nuevo.

---

## Diseño

Un solo call LLM por mensaje de texto devuelve una `UnifiedExtraction`.
El webhook rutea por `intent` y pasa la extracción al handler; los handlers usan la
extracción si existe y caen a regex si no.

### `src/lib/bot-llm/types.ts`

```ts
export type BotIntent =
  | 'asistencia_llegada'
  | 'asistencia_salida'
  | 'asistencia_estado'
  | 'gasto'
  | 'voucher'
  | 'pedido'
  | 'factura'
  | 'otro'

export type Confidence = 'alta' | 'media' | 'baja'

export type MissingField =
  | 'empleado'
  | 'hora'
  | 'estado'
  | 'monto'
  | 'categoria'
  | 'proveedor'

export interface UnifiedExtraction {
  intent: BotIntent
  confianza: Confidence
  // asistencia
  empleado: string | null
  hora: string | null
  estado: 'vacaciones' | 'licencia' | 'ausente' | null
  // gasto
  monto: number | null
  categoria: string | null
  proveedor: string | null
  empleado_gasto: string | null
  metodo_pago: string | null
  // común
  fecha: string | null
  faltan_campos: MissingField[]
  dudoso: boolean
  razon_duda: string | null
  raw: string
}
```

### `src/lib/bot-llm/extract-bot-message.ts`

`extractBotMessage(text: string, contextText?: string): Promise<UnifiedExtraction>`

- Llama `callOpenRouter` con jsonMode, temp 0.1, maxTokens ~700, prompt único.
- `contextText` se compone en el webhook: últimos N mensajes + estado pendiente legible
  (ej: "Asistencia pendiente: esperando a qué hora llegó Juan").
- **Fallback ante fallo/timeout/JSON inválido**: `fallbackExtract(text)` (ver abajo),
  devolviendo `confianza: 'baja'` y `dudoso: true` cuando toque.
- Sanitización: `parseNumberSafe` (reusar lógica de `extract-expense.ts` o duplicar),
  normalización de `hora` a `HH:MM` (aceptar `8:30`, `830`, `8.30`, `17`, `a las 8:30`),
  y `fecha` a `YYYY-MM-DD`.

### Prompt (bosquejo — el agente lo pulirá)

Reutiliza las reglas actuales del classifier (`intent-classifier.ts`) Y suma extracción:

- **Intents**: llegada/salida/estado vs gasto vs voucher vs pedido/factura vs otro.
  - `compré N [bastidor/acrílico/circular...]` → pedido, NO gasto.
  - `pagué [servicio]` → gasto; `pagué el pedido` → pedido; `transferí/deposité para
    factura/comprobante` → voucher.
  - `llegó/llegue/llegada` + hora → llegada; `salgo/salí/me voy/me fui/se fue/terminé/chau`
    + hora → salida; `vacaciones/licencia/ausente` → estado.
- **Campos**: extraer `empleado`, `hora`, `estado`, `monto` (normalizado: `18 mil`→18000,
  `18k`→18000, `$18.000,00`→18000, `18,000.00`→18000), `categoria`, `proveedor`,
  `empleado_gasto`, `metodo_pago`, `fecha`.
- **`faltan_campos`**: campos que el mensaje NO aporta y el intent necesita
  (llegada/salida necesitan `empleado` + `hora`; estado necesita `empleado`;
  gasto necesita `monto`; categoría/proveedor pueden faltar).
- **`dudoso`**: true si el monto es ambiguo, hay dos montos candidatos, la categoría
  es nueva/inferida, el proveedor/empleado no es seguro, o el mensaje es corto/genérico.
  `razon_duda`: texto breve explicando.
- **Contexto**: "CONTEXTO (últimos mensajes + estado pendiente): ..." para resolver
  respuestas cortas. Si el mensaje es la respuesta a una pregunta pendiente, devolvé el
  intent pendiente con los campos que completa.
- Devuelve SOLO JSON (jsonMode).

### `src/lib/bot-llm/fallback.ts`

`fallbackExtract(text: string): UnifiedExtraction` — red de seguridad, sin LLM:

1. `looksLikeExpense(text)` → `{intent:'gasto', confianza:'baja', dudoso:true, ...}` mapeando
   los campos de `parseExpense` (monto/categoria/proveedor/empleado/metodo_pago).
2. `looksLikeAttendance(text)` → intent asistencia_* según `parseAttendance.statusType`,
   con `empleado`/`hora`/`estado`.
3. Sino → `{intent:'otro', confianza:'baja', faltan_campos:[], dudoso:false}`.

---

## Fases de implementación

### Fase 1 — Módulo `src/lib/bot-llm/`

- Crear `types.ts`, `extract-bot-message.ts`, `fallback.ts`.
- Test unitario `extract-bot-message.test.ts` mockeando `@/lib/ai/openrouter`
  (respuestas JSON válidas, JSON inválido, fallo → fallback, "18 mil"→18000, hora `8:30`→`08:30`).
- Test unitario `fallback.test.ts` (pedido vs gasto, llegada vs salida, "se fue la luz" → otro).

### Fase 2 — Integración en `route.ts`

- Reemplazar el bloque `classifyIntent` (~L1397) por `extractBotMessage(inboundText, contextText)`.
- Construir `contextText` con los últimos mensajes + estado pendiente (expense/attendance/voucher).
- Dispatch por `intent`:
  - `asistencia_*` → `handleAttendanceMessage` (pasar `extraction`).
  - `gasto` → `handleExpenseMessage` (pasar `extraction`).
  - **`voucher` → NUEVO branch → `processVoucherMessage({type:'text'})`** (arregla la grieta).
  - `pedido`/`factura` → `handleVoiceText` (con `shouldSuppressVoiceOrder`).
  - `otro` → AI reply / nada (comportamiento actual).
- `confianza === 'media'` → ruteo directo pero `dudoso` activa la confirmación interactiva.
- Si `extractBotMessage` retorna fallback (`confianza 'baja'` por fallo LLM) → mantener los
  gates regex actuales como está hoy (el fallback ya los emuló; evitar doble dispatch).
- Conservar el bloque de interceptación de replies interactivas tal cual.

### Fase 3 — Handlers consumen la extracción

- **`attendance/index.ts`**: `processAttendanceMessage(args, extraction?)`. Si viene
  `extraction` con intent asistencia_*, construir `ParsedAttendance`
  (`statusType` según intent, `employeeName=empleado`, `time=hora`, `date=fecha||today`).
  - Si `faltan_campos` incluye `'empleado'` → "¿De quién es?" (estado pendiente).
  - Si incluye `'hora'` → **"¿A qué hora llegó/salió?"** (implementa "pedir la hora";
    reemplaza el default `00:00`).
  - Conservar máquina de estado multi-turn, dedupe con botones y `processAttendanceConfirmReply`.
- **`expenses/index.ts`**: `processExpenseMessage(args, extraction?)`. Construir
  `ParsedExpense` desde `extraction`; `amountAmbiguous = extraction.dudoso`. Si `dudoso`
  o categoría nueva o entidad sin resolver → flujo `confirming` (ya implementado).
- Ambos: si no llega `extraction`, usar los parsers regex actuales (fallback).

### Fase 4 — Fallback más seguro

- Endurecer `looksLikeExpense` (excluir "compré N [bastidor/acrílico/circular/tela]" → no gasto).
- Endurecer `looksLikeAttendance` (evitar "se fue la luz": requerir verbo de llegada/salida
  con contexto de persona, o mover esa keyword a detección con nombre).
- `intent-classifier.ts`: deprecar (dejar de usarse en route) o reutilizar sus reglas en el
  nuevo prompt. Decidir con el dueño si se elimina o se mantiene como referencia.

### Fase 5 — Deploy + WhatsApp E2E

- `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build`.
- Escenarios E2E (ver sección Verificación).

---

## Verificación — escenarios WhatsApp

### Asistencia
| Mensaje | Esperado |
|---|---|
| `llegó juan a las 8:30` | ✅ registrado 08:30 (o `⏰ TARDE-` si supera `entry_time`+`late_threshold`) |
| `juan llegó a las 8:30` | idem (LLM resuelve orden) |
| `llegó juan` | `¿A qué hora llegó juan?` → `9:30` → registra 09:30 |
| `llegó a las 8:30` | `¿De quién es?` → `juan` → registra |
| `llegó roberto` (no existe) | `No encontré... ¿De quién es?` |
| 2ª llegada el mismo día | botones `[✅ Corregir hora][❌ No tocar]`; ✅ sobrescribe recomputando TARDE, ❌ no toca |
| `juan se fue a las 17:00` sin llegada | `❌ Primero registrá su llegada.` |
| `se fue juan a las 17:00` con llegada | `🚪 Salida registrada: Juan / 17:00` (+ aviso si difiere del `exit_time` esperado) |
| `me voy` | `¿De quién es?` → `juan` → `¿A qué hora salió?` → `17` → registra 17:00 |
| `juan está de vacaciones` | status `VACACIONES` |

### Gastos
| Mensaje | Esperado |
|---|---|
| `pagué 18 mil de luz` | monto 18000, categoría luz, auto-guarda (sin confirmar) |
| `gasté 18k en insumos` | monto 18000 |
| `pagué $18.000,00 de luz` | monto 18000 (AR) |
| `transferí 18,000.00 por insumos` | monto 18000 (US) |
| gasto ambiguo / categoría nueva / proveedor sin resolver | preview + botones `[✅ Confirmar][✏️ Corregir][❌ Cancelar]` |
| ✏️ Corregir | pregunta qué campo; numérico → monto, texto → categoría |
| ❌ Cancelar | no guarda, limpia contexto |

### Routing / ambigüedad (clave)
| Mensaje | Esperado |
|---|---|
| `transferí para la factura 001` | **voucher** (ya NO lo captura expense) |
| `compré 3 bastidores 60x40` | **pedido** → voice, NO gasto |
| `compré pintura para el taller` | **gasto** |
| `pagué el pedido, mandame el comprobante` | pedido/voucher según contexto |
| `se fue la luz` | NO asistencia (otro / según contexto) |
| Respuesta corta en multi-turn (`juan`, `8:30`) | resuelta por el LLM con contexto |
| Mensajes normales / AI reply | intactos |

### Enrutamiento
- Mientras hay multi-turn pendiente, un texto **no** dispara Voice Orders
  (`hasPendingExpense`/`hasPendingAttendance`/`hasPendingVoucher` → `shouldSuppressVoiceOrder`).
- Taps a botones interceptados antes de Flows (sin regresión).

---

## Costo / riesgo

- **Costo:** 1 call LLM por mensaje de texto (hoy el classifier ya consume 1). Prompt más
  largo pero flash-lite ≈ $0.075/1M input, $0.30/1M output.
- **Latencia:** +300-800ms sobre lo que ya espera el webhook (el classifier ya era síncrono).
- **Riesgos:** alucinación de campos → mitigado con `dudoso` + confirmación interactiva;
  fallo/timeout LLM → `fallbackExtract` conserva el comportamiento actual; salida fuera de
  esquema → sanitización + fallback.
- **Compatibilidad:** `parse-attendance.ts`/`parse-expense.ts` y sus tests quedan como fallback.

## Archivos

| Archivo | Cambio |
|---|---|
| `src/lib/bot-llm/types.ts` | (nuevo) tipos `BotIntent`, `Confidence`, `UnifiedExtraction` |
| `src/lib/bot-llm/extract-bot-message.ts` | (nuevo) LLM extractor + prompt único + sanitización |
| `src/lib/bot-llm/fallback.ts` | (nuevo) fallback regex → `UnifiedExtraction` |
| `src/lib/bot-llm/extract-bot-message.test.ts` | (nuevo) tests del extractor (mockeando openrouter) |
| `src/lib/bot-llm/fallback.test.ts` | (nuevo) tests del fallback |
| `src/app/api/whatsapp/webhook/route.ts` | `classifyIntent` → `extractBotMessage`, branch `voucher`, pasar extracción |
| `src/lib/attendance/index.ts` | aceptar `extraction?`, "pedir la hora", usar `faltan_campos` |
| `src/lib/expenses/index.ts` | aceptar `extraction?`, `amountAmbiguous = dudoso` |
| `src/lib/expenses/parse-expense.ts` | endurecer `looksLikeExpense` (pedido vs gasto) |
| `src/lib/attendance/parse-attendance.ts` | endurecer `looksLikeAttendance` ("se fue la luz") |
| `src/lib/ai/intent-classifier.ts` | deprecar o reusar reglas en el nuevo prompt |
| `docs/bots/architecture.md` | §6: documentar el extractor unificado |
