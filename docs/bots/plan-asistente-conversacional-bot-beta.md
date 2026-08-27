# Plan: Asistente conversacional en Bot Beta

> Para un agente implementador. **Estado:** planificado — no iniciado.
> **Objetivo:** convertir el tab `/bot-beta` en un asistente conversacional solo-dueño (rioplatense), que ejecute y consulte datos reales de `backend_gal`, sin alucinar, y sirva como entorno de pruebas antes de promover al webhook de WhatsApp.
> **Decisiones confirmadas:** solo dueño (un número = dueño, sin whitelist/flag), español rioplatense, consulta + ejecución, modelo único `google/gemini-2.5-flash-lite` (sin DeepSeek), cero alucinación pero manteniendo conversación, implementación aislada en Bot Beta, panel `/bot-escalations` en wacrm.

Contexto: [`architecture.md`](./architecture.md), [`gaps-bot-gastos.md`](./gaps-bot-gastos.md), [`plan-bot-llm-unificado.md`](./plan-bot-llm-unificado.md), [`voice-orders.md`](./voice-orders.md).

---

## 1. Estado relevado — Bot Beta hoy

### UI
- `src/app/(dashboard)/bot-beta/page.tsx:625` — client component, dos columnas: chat (izq) + debug (der). Tabs debug `voice_logs`/`logs` con `VOICE_STEP_LABELS:33`.
- Composer con textarea + grabar audio (`MediaRecorder` webm/opus) + upload `audio/*` + botón Send.
- Estado: `turns: Turn[]:27`, `voiceResult: VoiceOrderResult`, `pendingVariantRef`/`pendingClientRef`/`pendingInvoiceRef` via `useRef` (no persistido).
- Reset limpia todo `page.tsx:254`.

### API
- `src/app/api/bot-beta/run/route.ts:36` — `POST {text, phone, pendingVariantItems, pendingClientName, pendingInvoice}` → `processTextOrder({text, senderPhone, commit:false})` `src/lib/voice-orders/index.ts:189`. Solo pedidos.
- `src/app/api/bot-beta/voice-run/route.ts:35` — `POST FormData{audio, phone, name}` → `processVoiceOrder({buffer, mimeType})` `src/lib/voice-orders/index.ts:172`. Whisper `openai/whisper-1` + `parseOrder` `src/lib/voice-orders/parse-order.ts:4` (flash-lite, temp 0.1, few-shot).
- `maxDuration 120` en ambos. No tocan Supabase `conversations` ni `engineSend*`.

### Bots existentes (webhook)
- `src/app/api/whatsapp/webhook/route.ts:1921` — `processMessage` con `extractBotMessage` `src/lib/bot-llm/extract-bot-message.ts:261` (lite, jsonMode, prompt `EXTRACT_PROMPT:6`), `UnifiedExtraction` `src/lib/bot-llm/types.ts:39` (intents `asistencia_*|gasto|multi_expense|voucher|pedido|factura|otro`, `confianza`, `tipo_gasto`, `saldo_pendiente`, `multipleExpenses`), `buildBotContextText` `src/lib/bot-llm/context.ts:21`, dispatch por intent + fallback `looksLike*`, `router_logs` `route.ts:992`.
- FacBal `src/lib/facbal/client.ts:890` — `FACBAL_API_URL` + `X-API-Key`, `listExpenses:839`, `listProviders:674`, `listEmployees:706`, `getAttendance:655`, `buscarProductos:229`, `suggestPrice:291`, `bulkPrice:337`.

**Gap:** Bot Beta solo testea pedidos; no hay asistente general, no hay consultas de gastos/asistencia, no hay chitchat.

---

## 2. Diseño — Asistente en Bot Beta

### 2.1 Principio anti-alucinación sin matar conversación

Separar factual vs chitchat (con `flash-lite` único, `DEFAULT_MODEL` `src/lib/ai/openrouter.ts:3`):

| Tipo | Ejemplo | Estrategia |
|---|---|---|
| Factual | `¿cuánto gasté hoy?`, `¿cuánto debo a X?`, montos/fechas/nombres | **Grounded obligatorio**: llamar `tools.ts` → `backend_gal` ANTES de generar. Prompt: "Si el dato no está en toolResults, decí 'no lo encontré' y escala. Nunca inventes." |
| Transaccional | `pagué 18k luz`, `llegó juan 8:30` | Determinístico: `UnifiedExtraction` → `fuzzyMatchExpense` `src/lib/expenses/fuzzy-match.ts:305` → `executeExpense`. LLM solo verbaliza resultado. |
| Chitchat/ayuda | `hola`, `¿qué podés hacer?`, `gracias` | Libre rioplatense, sin tools. No hay alucinación porque no hay claim factual. `temperature 0.6` |
| Ambiguo | `gasté algo ayer` (sin monto) | Pregunta desambiguación o escala (3 niveles `archive/bot-personal.md:165`) |

Esto permite tono canchero sin inventar contabilidad.

### 2.2 Componentes nuevos

```
src/lib/bot-assistant/
├── prompts.ts       — system prompt rioplatense + reglas grounded/chitchat
├── tools.ts         — wrappers solo-lectura a backend_gal (listExpenses, searchProviders, etc.)
├── history.ts       — turns[] → historyText para extractor + responder
├── responder.ts     — callOpenRouter lite temp0.6 (no jsonMode) con {history, extraction, toolResults, knowledge}
└── orchestrator.ts  — extract → router ligero → tools → responder → logs
```

Reutiliza `callOpenRouter` `src/lib/ai/openrouter.ts:19`, `retrieveKnowledge` `src/lib/ai/knowledge.ts:84` (pgvector `vector(1536)` `supabase/migrations/030_ai_knowledge.sql:125`), `embedTexts` `src/lib/ai/embeddings.ts:18` si se quiere RAG catálogo en Fase 3.

**RAG:** en Bot Beta Fase 1 no es obligatorio; `tools` con llamadas directas ya evitan alucinación. RAG catálogo (`ai_catalog_embeddings` HNSW) queda para Fase 3 `archive/bot-personal.md:175`.

### 2.3 Flujo en Bot Beta

```
page.tsx: turns[] + input text/audio
  → POST /api/bot-beta/assistant {text, phone, history: turns.slice(-10), pendingState}
    → orchestrator.ts:
        1. history.ts → historyText
        2. extractBotMessage(text, historyText) (lite, jsonMode)
        3. router ligero: alta/media → handler transaccional; otro/baja → responder
        4. si factual → tools.ts (Promise.all paralelo) + retrieveKnowledge
        5. responder.ts → reply + logs
    → {reply, extraction, toolResults, knowledge, logs, pendingState}
  → page.tsx: append Turn{role:'bot', content: reply, assistantDebug}
```

Audio: `voice-run/assistant` o reutilizar `transcribe.ts` `src/lib/voice-orders/transcribe.ts` (Whisper) → texto → mismo orchestrator.

---

## 3. Fases de implementación

### Fase 1 — Asistente base en Bot Beta (2-3 días)

**Archivos nuevos:**

- `src/lib/bot-assistant/prompts.ts`
  ```ts
  export const ASSISTANT_SYSTEM_PROMPT = `Sos el asistente de Bastidores GAL, hablás en español rioplatense, directo y canchero pero sin inventar.
  Capacidades: registrar gastos, registrar llegadas/salidas, consultar gastos/proveedores/empleados, armar presupuestos.
  Reglas:
  - Si te piden un dato (monto, fecha, nombre, saldo), SOLO usá lo que está en toolResults/knowledge. Si no está, decí 'no lo encontré' y ofrecé dejarlo en revisión en /bot-escalations. Nunca inventes.
  - Para saludos y "¿qué podés hacer?" respondé libre, sin tools.
  - Si falta un dato (ej: gasto sin monto), preguntá puntual: "¿Cuánto fue?"
  - Tono: rioplatense, breve, con emoji ocasional.`
  ```

- `src/lib/bot-assistant/tools.ts`
  ```ts
  // Solo lectura, timeout 10-30s como en client.ts
  export async function fetchExpensesToday() { return listExpenses({from_date: today(), to_date: today()}) }
  export async function fetchProviders(q: string) { return searchProviders(q) }
  // + fetchEmployees, fetchAttendance(employeeId, date), fetchExpenseCategories, searchProducts
  // Cada fn loggea {tool, duration_ms, resultCount}
  ```

- `src/lib/bot-assistant/history.ts`
  ```ts
  export function buildHistoryText(turns: {role:string, content:string}[]): string {
    return turns.slice(-10).map(t => `${t.role}: ${t.content}`).join('\n')
  }
  // + buildBotContextText reuso src/lib/bot-llm/context.ts:21 para pendingState si existe
  ```

- `src/lib/bot-assistant/responder.ts`
  ```ts
  import { callOpenRouter } from '@/lib/ai/openrouter'
  export async function generateAssistantReply(args: {
    historyText: string, extraction: UnifiedExtraction | null,
    toolResults: Record<string, unknown> | null, knowledge: string[]
  }): Promise<string> {
    const userMessage = `HISTORIAL:\n${args.historyText}\n\nEXTRACCIÓN:\n${JSON.stringify(args.extraction)}\n\nDATOS REALES (tools):\n${JSON.stringify(args.toolResults)}\n\nCONOCIMIENTO:\n${args.knowledge.join('\n')}`
    const { text } = await callOpenRouter({
      systemPrompt: ASSISTANT_SYSTEM_PROMPT,
      userMessage,
      temperature: 0.6,
      maxTokens: 600,
      // model = default lite, sin jsonMode
    })
    return text
  }
  ```

- `src/lib/bot-assistant/orchestrator.ts`
  ```ts
  export interface AssistantResult {
    reply: string
    extraction: UnifiedExtraction | null
    toolResults: Record<string, unknown> | null
    knowledge: string[]
    logs: {step:string, data:unknown}[]
    pendingState?: unknown
  }
  export async function runAssistant(args: {
    text: string, phone: string, history: Turn[], pendingState?: unknown
  }): Promise<AssistantResult>
  // Pasos: extractBotMessage → decide tools (si intent otro/factura o consulta con "cuánto/cuándo/quién") → Promise.all tools → retrieveKnowledge → responder
  ```

- `src/app/api/bot-beta/assistant/route.ts`
  ```ts
  export const maxDuration = 60
  export async function POST(req: Request) {
    const { text, phone, history, pendingState } = await req.json()
    const result = await runAssistant({ text, phone: phone||'1145678901', history: history||[], pendingState })
    return NextResponse.json(result)
  }
  ```

**Edición:**

- `src/app/(dashboard)/bot-beta/page.tsx`
  - Agregar `Tabs` superiores: `Asistente` (default) | `Pedidos` (actual `run`/`voice-run`). Ver `src/components/ui/tabs.tsx`.
  - Nuevo estado: `assistantTurns: Turn[]`, `assistantDebug: AssistantResult | null`, `assistantSending`, `assistantTab: 'extraccion'|'tools'|'respuesta'|'logs'`.
  - `sendAssistantText` → `fetch('/api/bot-beta/assistant')`, append user+bot turns, set `assistantDebug`, `setDebugTab('assistant_extraccion')`.
  - Audio: nuevo `sendAssistantAudio` → transcribe local o `POST /api/bot-beta/assistant` con `text=transcription`.
  - Debug derecha: 4 tabs nuevos:
    - `Extracción` → `assistantDebug.extraction` JSON + `llm_raw`/`fallback_reason`
    - `Tools` → tabla `toolResults` con `duration_ms`, `count`
    - `Respuesta` → `reply` + `knowledge` usados
    - `Logs` → `assistantDebug.logs` (mismo render que `VOICE_STEP_LABELS:33`)
  - Placeholder textarea: `"Probá: 'hola', '¿qué podés hacer?', 'pagué 18k luz', '¿cuánto gasté hoy?', 'llegó juan 8:30'"`
  - Mantener `sendText`/`sendAudio` viejos intactos bajo tab `Pedidos` para regresión.

**No tocar:** `src/app/api/whatsapp/webhook/route.ts`, `src/lib/expenses/*`, `src/lib/attendance/*`, migraciones.

### Fase 2 — Router unificado + /bot-escalations (tras validar Bot Beta)

- `src/lib/bot/router.ts` — decisor único que reemplaza bloque `route.ts:1532-1600`, absorbe `shouldSuppressVoiceOrder` `src/lib/bot-coordination.ts`.
- `supabase/migrations/046_bot_escalations.sql` — `CREATE TABLE bot_escalations (... estado IN ('pendiente','resuelto','descartado'))` `archive/bot-personal.md:138` (046 libre, 045 es `bot_debug_logs.sql`), RLS `is_account_member`.
- `src/app/(dashboard)/bot-escalations/page.tsx` — lista pendiente, detalle `message_text`+`entidades`+`razon`, acciones `resuelto/descartado`. Patrón `voucher-debug/page.tsx`.
- Promover `orchestrator` al webhook: `processMessage` llama `runAssistant` cuando `!flowConsumed` y `intent==otro` o consulta.

### Fase 3 — Handler factura + RAG catálogo

- `src/lib/facturas/index.ts` — `intent=factura` deja de ir a `handleVoiceText` `route.ts:1575`; usa `getFacturasPendientes` + respuesta con saldos reales.
- `supabase/migrations/047_ai_catalog_embeddings.sql` — `ai_catalog_embeddings (product_id, embedding vector(1536))` HNSW + RPC `match_ai_catalog_semantic` (copia `030_ai_knowledge.sql:125`), job `scripts/sync-catalog.ts` con `embedTexts` `src/lib/ai/embeddings.ts:18`.

### Fase 4 — Gaps G1-G6 + pulido

- `src/lib/bot-llm/types.ts:54` ya tiene `tipo_gasto/saldo_pendiente`; completar `fuzzy-match.ts:271` prioriza `tipo_gasto` y `facbal/client.ts:575` `mov_type` + `backend_gal/main.py:3995`.

---

## 4. Verificación — Bot Beta

Ejecutar `npm run typecheck && npm run lint && npm run test && npm run build`.

| Mensaje en Bot Beta (tab Asistente) | Esperado |
|---|---|
| `hola` | Saludo rioplatense, sin tools, `intent=otro` |
| `¿qué podés hacer?` | Lista: gastos, asistencia, pedidos, consultas |
| `pagué 18 mil de luz` | `gasto` alta, `monto 18000`, preview `✅ Confirmar/✏️/❌` (si ambiguo) verbalizado por responder |
| `¿cuánto gasté hoy?` | `tools listExpenses(today)` → total real o "hoy no registraste gastos" (nunca inventa) |
| `llegó juan a las 8:30` | `asistencia_llegada` → `createAttendance` (en Bot Beta dryRun=true, no escribe; muestra "simulado") |
| `¿quién faltó ayer?` | `getAttendance` por empleados → lista real |
| `gasté algo` (sin monto) | `¿Cuánto fue?` (multi-turn) |
| `compré 3 bastidores 60x40` | `pedido` → delega a `processTextOrder` (tab Pedidos) o responder "¿querés que arme el presupuesto?" |
| Audio `hola quiero 2 bastidores 60x40` | Whisper → texto → mismo flujo |

---

## 5. Archivos — resumen

| Archivo | Acción |
|---|---|
| `src/lib/bot-assistant/prompts.ts` | nuevo |
| `src/lib/bot-assistant/tools.ts` | nuevo |
| `src/lib/bot-assistant/history.ts` | nuevo |
| `src/lib/bot-assistant/responder.ts` | nuevo |
| `src/lib/bot-assistant/orchestrator.ts` | nuevo |
| `src/app/api/bot-beta/assistant/route.ts` | nuevo |
| `src/app/(dashboard)/bot-beta/page.tsx` | editar (tabs Asistente/Pedidos, debug 4 tabs) |
| `src/lib/bot/router.ts` | Fase 2 |
| `supabase/migrations/046_bot_escalations.sql` | Fase 2 |
| `src/app/(dashboard)/bot-escalations/page.tsx` | Fase 2 |
| `docs/bots/architecture.md` | Fase 2 §6 documentar asistente |

---

## 6. Riesgos

- **Lite seco:** subir `temperature 0.6→0.7` o few-shot en `prompts.ts`. Si persiste, cambiar solo `responder.ts` a `google/gemini-2.5-flash` (1 env var `ASSISTANT_MODEL`).
- **Latencia:** `extract 500ms` + `tools 300ms (Promise.all)` + `responder 500ms` ≈1.3s, dentro de `maxDuration 60` y `after()` webhook. En Bot Beta es sync, no bloquea `200 OK`.
- **Costo:** dueño bajo volumen, lite ≈$0.001/mensaje.
