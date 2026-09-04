# Bot Beta — Resumen para agente validador

> Estado actual (no plan). Fuentes verificadas en código. Para otro agente que debe validar el bot antes de promoverlo a producción.

---

## 1) Tecnología / lenguaje

| Capa | Stack |
|------|-------|
| **Lenguaje** | TypeScript 5 (strict), Node 20 |
| **Framework** | Next.js 16 App Router (`src/app/api/.../route.ts`), `maxDuration=60` en rutas de bot |
| **DB / Auth** | Supabase Postgres + `supabase-js` service-role (`supabaseAdmin()` en webhook/bot-beta), RLS por `account_id` |
| **LLM** | OpenRouter — `google/gemini-2.5-flash-lite` para `extractBotMessage` y `parseOrder`, `google/gemini-2.5-flash` para vouchers, `openai/whisper-1` para audio — via `src/lib/ai/openrouter.ts` (`callOpenRouter`) |
| **KB** | `retrieveKnowledge` híbrido semántico (pgvector `match_ai_knowledge_semantic`) + FTS (`match_ai_knowledge_fts`) en `src/lib/ai/knowledge.ts:84` |
| **Backend pedidos/gastos** | `backend_gal` FastAPI `https://api-bastidores.onrender.com` via `src/lib/facbal/client.ts` (`X-API-Key`) — `suggestPrice`, `bulkPrice`, `matchVoucherByName`, `listExpenses`, `createPresupuesto`, etc. |
| **Tests** | Vitest, 711 tests verdes (2 fallos timezone en `date-utils.test.ts` solo en UTC) |

---

## 2) ¿Para qué es el bot? (exacto)

**Bot Beta = asistente conversacional interno de Bastidores GAL (taller de marcos/bastidores). No es un bot de ventas genérico.**

Capacidades declaradas en `src/lib/bot-assistant/prompts.ts:1` y `docs/bots/architecture.md:92`:

1. **Presupuestos / pedidos** — parsea medidas/variantes/cantidades (`2 bastidores 60x40 sin tela`, `rollo 2x5`, `1 circular 30x30`, etc.) → `resolveItems → priceItems → createPresupuesto` → presupuesto real en `backend_gal` + imagen `/api/budget-image/[id]` (vercel/og edge).
2. **Gastos** — `pagué $X a Y` → `fuzzyMatchExpense → resolveExpenseCategory` → registro en `expenses`/`expense_categories` (backend_gal).
3. **Asistencia** — `llegó juan a las 8:30` / `me voy 17:00` / `vacaciones` → `GET/POST /attendance` (backend_gal) con `TARDE-HH:MM`, `exit_time`.
4. **Vouchers** — imagen/PDF comprobante → `extractVoucherData` (Gemini vision) → `matchVoucherByName` → `registrarPago` (dryRun en Beta).
5. **Consultivo / chitchat** — `cuánto gasté hoy`, `quién faltó ayer`, `precio de bastidor 100x120`, saludos `hola` — responde en rioplatense **anti-alucinación**: solo datos de `toolResults`/`knowledge`; si no hay dato → `no lo encontré` y deriva a `/bot-escalations` (`prompts.ts:5`).

**No conectado al webhook productivo.** Vive solo en `/bot-beta` (dashboard) con teléfono dummy `11999999999` (`src/lib/bot-beta/unified-handler.ts:13`). El webhook real (`src/app/api/whatsapp/webhook/route.ts:1883`) sigue con el pipeline legacy (Flows → voucher → `decideDispatch` → voice/expense/attendance/auto-reply).

---

## 3) Archivos clave

### Núcleo asistente (Bot Beta conversacional)

```
src/lib/bot-assistant/orchestrator.ts:36  # runAssistant({text,phone,history}) — entry. extract → shouldCallTools(:19) → runToolsForQuery + buildExpensePreview(fuzzyMatch) → generateAssistantReply
src/lib/bot-assistant/tools.ts:232        # runToolsForQuery — decide tools por intent/keywords (expenses, providers, employees, attendance, precios_referencia). fetchPreciosReferencia(:85) genérico vía suggestPrice
src/lib/bot-assistant/responder.ts:5      # generateAssistantReply — systemPrompt rioplatense + history/extraction/toolResults/knowledge → callOpenRouter
src/lib/bot-assistant/prompts.ts:1        # ASSISTANT_SYSTEM_PROMPT — reglas sueldo/voucher/rollo 2x5
src/lib/bot-assistant/history.ts:6        # buildHistoryText — últimas 10 turns "role: content"
```

### Handlers y APIs Bot Beta

```
src/lib/bot-beta/unified-handler.ts:106   # runUnifiedBotBeta — orquestador unificado (carga contexts dummy, extractBotMessage, decideDispatch, voucher forced-client/letter, delega a runAssistant, badge dispatchedTo)
src/lib/bot-beta/voucher-dryrun.ts:52     # voucher en modo simulación
src/app/api/bot-beta/assistant/route.ts:7 # POST texto/audio → runAssistant (transcribeAudio si multipart)
src/app/api/bot-beta/unified/route.ts:9   # POST texto/audio/imagen voucher → runUnifiedBotBeta (FormData, extractVoucherData, accountId)
src/app/api/bot-beta/voice-run/route.ts   # voice texto/audio → processTextOrder/processVoiceOrder directo
src/app/(dashboard)/bot-beta/page.tsx      # UI de prueba
```

### Extracción / Router compartido

```
src/lib/bot-llm/extract-bot-message.ts    # UnifiedExtraction (LLM) + fallback regex
src/lib/bot-llm/types.ts:1                # BotIntent: gasto/multi_expense/pedido/factura/voucher/asistencia_*/otro + Confidence alta/media/baja
src/lib/bot/router.ts:37                  # decideDispatch(state) — flow/interactive → expense/attendance → voucher → voice → catch-all regex(:82)
src/lib/bot-llm/context.ts                # buildBotContextText — serializa expense/attendance/voucher/voice contexts para el extractor
```

### Voice-orders (pipeline pedidos, reutilizado por bloque pegado)

```
src/lib/voice-orders/parse-order.ts:5     # PARSE_PROMPT + parseOrder(text,phone,logs,history) — LLM extrae items/entidades/variante_respuesta/confirmación
src/lib/voice-orders/index.ts:7           # askConfirmMsg + runPipeline (variante/confirmar/cancelar/precio rollo → resolveItems → priceItems → createPresupuesto)
src/lib/voice-orders/execute-order.ts     # resolveItems, priceItems, searchOrCreateClient, createPresupuesto
src/lib/ai/context.ts:19                  # buildConversationContext(db, conversationId) → ChatMessage[] (reusable para historia real)
src/lib/ai/knowledge.ts:84                # retrieveKnowledge(db, accountId, config, query, k=5)
src/lib/ai/config.ts:16                   # loadAiConfig (is_active, auto_reply_enabled, assistantEnabled futuro)
```

---

## 4) Estructura del proyecto (relevante)

```
wacrm/
├── supabase/migrations/
│   ├── 029_ai_reply.sql          # ai_configs + conversations.ai_autoreply_disabled/ai_reply_count + claim_ai_reply_slot
│   ├── 035_voice_context.sql     # conversations.voice_context JSONB (pendingVariantItems/pendingInvoice/pendingClientName)
│   ├── 036_expense_context.sql   # conversations.expense_context
│   ├── 040_voucher_context.sql   # conversations.voucher_context
│   ├── 044_attendance_context.sql
│   └── 045_bot_debug_logs.sql    # router_logs + attendance_extractions
├── src/
│   ├── app/api/
│   │   ├── whatsapp/webhook/route.ts  # 1883 líneas — dispatch productivo (Flows → AI auto-reply → extractor → decideDispatch → voucher bg)
│   │   ├── bot-beta/{assistant,unified,voice-run,voucher}/route.ts
│   │   └── budget-image/[id]/route.tsx # vercel/og edge image
│   ├── lib/
│   │   ├── bot-assistant/        # asistente Beta
│   │   ├── bot-beta/             # unified-handler + dryRun
│   │   ├── bot-llm/              # extracción unificada
│   │   ├── bot/                  # router compartido
│   │   ├── voice-orders/         # pedidos texto/audio
│   │   ├── expenses/             # parse/execute/fuzzy-match/confirm
│   │   ├── attendance/           # parse/context
│   │   ├── ai/                   # knowledge, context, auto-reply, generate, providers
│   │   ├── facbal/client.ts      # cliente backend_gal
│   │   └── flows/engine.ts       # Flows Engine (prioridad #1 en webhook)
│   └── app/(dashboard)/bot-beta/ # UI test
└── docs/bots/
    ├── architecture.md
    ├── plan-bot-beta-a-produccion-asistente.md  # plan a implementar (no iniciado)
    └── plan-asistente-conversacional-bot-beta.md
```

---

## 5) Diagrama simple — cómo fluye Bot Beta hoy

```mermaid
flowchart TD
  U[Usuario en /bot-beta\ntexto o audio o imagen voucher] --> R{API route\nassistant / unified}
  R -->|multipart audio| W[transcribeAudio\nWhisper openai/whisper-1]
  R -->|multipart voucher| V[extractVoucherData\nGemini 2.5 flash vision]
  R --> T[runUnifiedBotBeta\nunified-handler.ts:106]
  W --> T
  V --> T

  T --> C{¿Hay accountId?\nSupabase dummy conv 11999999999}
  C -->|sí| L[Load contexts\nloadExpense/Attendance/VoucherContext\n+ voice_context + buildBotContextText]
  C -->|no| H[history.slice -10]

  L --> E[extractBotMessage\nLLM gemini-flash-lite]
  H --> E

  E --> D[decideDispatch\nrouter.ts:37\npendingExpense/Attendance/Voucher\nintent + confianza]

  D --> VF{¿Voucher pending\n+ caption o letra?}
  VF -->|letra A/B| VL[Letter selection\ndryRun + saveVoucherContext]
  VF -->|caption nombre| FC[Forced search\nmatchVoucherByName]
  VF -->|no| A[runAssistant\norchestrator.ts:36]

  A --> S{shouldCallTools?\nintent != otro o keywords factual}
  S -->|sí| TQ[runToolsForQuery + buildExpensePreview\nlistExpenses/providers/employees\nsuggestPrice precios_referencia\nfuzzyMatchExpense]
  S -->|no| SK[skip tools — chitchat]

  TQ --> G[generateAssistantReply\nresponder.ts:5\nsystem rioplatense + toolResults\n+ knowledge[] + extraction]
  SK --> G
  FC --> G
  VL --> OUT

  G --> OUT[Reply + dispatchedTo badge\n+ extraction + toolLogs\n+ logs + dummyConversationId]
  OUT --> UI[/bot-beta page\nrender reply + debug panel/]
```

Flujo en texto: **usuario → intención (extractBotMessage) → respuesta (generateAssistantReply)** con `toolResults` en medio solo si `shouldCallTools` es true; history de hasta 10 turns alimenta al LLM.

**Diferencia con producción:** en el webhook real (`webhook/route.ts:1025`) el mensaje pasa por `dispatchInboundToFlows → automations → dispatchInboundToAiReply → extractBotMessage → decideDispatch → handleExpense/Attendance/Voice(proceso real) → voucher pendingTexts`. En Beta no hay Flows ni auto-reply; todo es `runAssistant` con history dummy y contexts best-effort del contacto `11999999999`.

---

## 6) Notas para el validador

- **Writes reales vs dummy:** `runAssistant` es read-only (tools + preview no escriben). `processTextOrder(commit:false)` es dryRun; `commit:true` o `respuesta_confirmacion + pendingInvoice` sí escribe vía `createPresupuesto` en `backend_gal` (mismo que lee `galv2-tauri`). Env vars `OPENROUTER_API_KEY`, `FACBAL_API_URL/KEY` ya viven en prod.
- **KB hoy vacío:** `orchestrator.ts:61 knowledge=[]` (hook Fase 3 comentado `:63`). En prod se integra `retrieveKnowledge` — Beta puede probar sin KB.
- **Guard de confirmación:** `hasPendingVoice` (voice_context con `pendingInvoice/pendingVariantItems`) debe ganarle al asistente para que `si/dale` no sea robado — es el fix central del plan productivo.
- **Planes relacionados:** `docs/bots/plan-bot-beta-a-produccion-asistente.md` (asistente + bloque conversación pegada), `docs/bots/architecture.md` (visión ecosistema).
