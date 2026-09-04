# Plan: Bot Beta a producción — asistente conversacional en el webhook + bloque de conversación pegado

> Para un agente implementador. **Estado:** planificado — no iniciado.
> **Objetivo:** validar y promover el asistente conversacional del Bot Beta (`runAssistant`) al webhook de WhatsApp reemplazando el bot actual del pipeline, sin quitar nada que ya funciona (Flows, Voucher, gastos, asistencia, pedidos). Agregar detección de conversaciones copiadas/pegadas de clientes (formato WhatsApp export, ambos lados) → propuesta de presupuesto → confirmación → crear presupuesto real en `backend_gal` (lo que lee galv2-tauri) + imagen del presupuesto (ya existe `sendBudgetImage`).
> **Decisiones confirmadas:** asistente integra KB (sí); asistente primero (responde el asistente, auto-reply solo si calla); `/bot-escalations` queda para después; enablement por **config flag por cuenta** (`assistantEnabled`); pedidos de texto ("2 bastidores 60x40 sin tela") **siguen en el pipeline de voice-orders** (propuesta → "confirmá" → presupuesto + imagen); el formato pegado es **WhatsApp export, ambos lados** (líneas `[14:32, 2/9/2026] Nombre: texto`, los mensajes propios aparecen como "Vos").
> **Writes reales** tras confirmación (la simulación dummy del Beta pasa a ejecución real; comportamiento igual al de producción actual). Env vars `OPENROUTER_API_KEY`, `FACBAL_API_URL`, `FACBAL_API_KEY` ya viven en el host de producción. Rollback = revert del commit del webhook + flag off.

Contexto: [`architecture.md`](./architecture.md), [`plan-asistente-conversacional-bot-beta.md`](./plan-asistente-conversacional-bot-beta.md), [`plan-bot-llm-unificado.md`](./plan-bot-llm-unificado.md), [`voice-orders.md`](./voice-orders.md).

---

## 1. Estado relevantemente — producción hoy

### Webhook (`src/app/api/whatsapp/webhook/route.ts`, 1883+ líneas)
- Orden de dispatch: Flows (`flowConsumed`) → interactive reply → contexto voucher (`hasPendingVoucher`, corre SIEMPRE independiente del intent, `route.ts:1597`) → `extractBotMessage` (`src/lib/bot-llm/extract-bot-message.ts`) → `decideDispatch` (`src/lib/bot/router.ts`) → handlers bg tasks (expense/attendance/voucher/voice) → `dispatchInboundToAiReply` (auto-reply, `src/lib/ai/auto-reply.ts`).
- Voice/order: `handleVoiceText`/`handleVoiceAudio` (`route.ts:768-824`) llaman `processTextOrder`/`processVoiceOrder` (`src/lib/voice-orders/`) con `commit:false`; en "confirmar" `createPresupuesto` corre siempre (write real). Estado pendiente en `conversations.voice_context` (JSONB) vía `loadVoiceContext`/`saveVoiceContext` (`route.ts:693-721`). `sendBudgetImage` (`route.ts:723-744`) envía `/api/budget-image/[id]` (`src/app/api/budget-image/[id]/route.tsx`, vercel/og, runtime edge).
- `decideDispatch` («shared router») NO conoce `hasPendingVoice` ni responde `otro` como conversación: el catch-all de fallback regex (`router.ts:82-84`) manda casi cualquier texto no consumido a voice → mensaje de error del pipeline de pedidos ("No se reconoció ningún producto"). Ese es el comportamiento roto que el asistente viene a arreglar.

### Asistente (Bot Beta, no conectado al webhook)
- `runAssistant` (`src/lib/bot-assistant/orchestrator.ts:36`) — `{ text, phone, history: {role,content}[] }` → extract → `shouldCallTools` (`:19`) → tools read-only FacBal (`tools.ts`) + preview determinístico de gasto → `generateAssistantReply` (`responder.ts`, rioplatense, anti-alucinación). Solo se usa en `api/bot-beta/{assistant,unified}` con dummy `11999999999`.
- `knowledge` hoy siempre `[]` (hook Fase 3 comentado en `orchestrator.ts:63-64`). En producción se integra `retrieveKnowledge` (`src/lib/ai/knowledge.ts`).
- `buildConversationContext` (`src/lib/ai/context.ts:19`) devuelve exactamente `{role,content}[]` que `runAssistant` espera — reutilizable como historial real.
- Ciclo de presupuesto pegado: `parseOrder` (`src/lib/voice-orders/parse-order.ts`) ya extrae múltiples items/medidas/variantes del dropdown y tiene la regla "Si dice 'a nombre de X' o 'para X', ese es el cliente_nombre" (`:45`) → reutilizable para inyectar el nombre del cliente del bloque pegado sin tocar voice-orders.

### Validación / bloqueo
- `typecheck` ✅ · `test` 711/713 (2 fallos por zona horaria AR en `src/lib/dashboard/date-utils.test.ts`, CI en UTC pasa) · **`lint` ❌ 8 errores** → CI roto en `main` (`.github/workflows/ci.yml` corre lint/typecheck/test/build).
- Errores lint: `src/lib/bot-beta/voucher-dryrun.ts:52` · `src/lib/voice-orders/synonyms.ts:70` · `src/app/api/bot-beta/unified/route.ts:35,39,51,107` · `src/app/api/whatsapp/webhook/route.ts:1538-1539` (prefer-const/no-explicit-any).

---

## 2. Plan de implementación

### 0. Pre-requisito — desbloquear CI (8 errores lint)
Fix mínimo (prefer-const / no-explicit-any) en los 6 archivos del §1. Verificar `lint` limpio, `typecheck` ✅, `test` sin regresiones (711 verdes + 2 de timezone igual que hoy).

### 1. Wrapper de producción del asistente — `src/lib/bot-assistant/production.ts`
`runAssistantForWebhook({ accountId, conversationId, contactId, userId, text, phone })`, mismo contrato de `dispatchInboundToAiReply` (propio try/catch, nunca lanza, corre en bg task del webhook):
- Gates: config `assistantEnabled` on; thread sin `assigned_agent_id`; `ai_autoreply_disabled` no seteado; texto no consumido.
- Historial real: `buildConversationContext(db, conversationId)` → pasar directo a `runAssistant`.
- KB: `retrieveKnowledge(db, accountId, config, latestUserMessage)` → pasar como `knowledge`. Extender `runAssistant` con args aditivos `{ knowledge, readonlyExpensePreview }` (Beta sigue con `[]`/activo por defecto).
- Si `runAssistant` no produce reply (o la respuesta marca escalar) → fallback a `dispatchInboundToAiReply` (asistente primero, auto-reply si calla).
- `readonlyExpensePreview: true` en prod: `buildExpensePreview` → `fuzzyMatchExpense → resolveExpenseCategory` NO crea categorías en FacBal (evita el write colateral aceptado solo en Beta). Cuando la categoría no existe → devolver `categoryId:null, categoryName:null, created:false` sin `createExpenseCategory`.

### 2. Router — `src/lib/bot/router.ts`
- Nuevo `DispatchedTo = 'assistant'` (`:7`) y `hasPendingVoice` en `RouterState` (`:17`) — voiceCtx con `pendingVariantItems | pendingInvoice | pendingClientName` no vacío.
- CRÍTICO (guard de confirmación): si `hasPendingVoice` → `dispatchedTo 'voice'` ANTES de cualquier rama de asistente, para que el "si"/"dale" posterior a una propuesta siga yendo al pipeline de pedidos (→ `createPresupuesto` + imagen), no al asistente.
- `intent === 'otro'` → `assistant` (antes del catch-all de voice de `router.ts:82-84`). Incluye saludos ("hola" → otro/baja).
- `pedido`/`factura` confianza != baja → `voice` (sin cambios). `expense`/`attendance`/`voucher`/`flow`/`interactive` sin cambios.

### 3. Webhook — integración + bloque pegado (`route.ts`)
- `case 'assistant'` en el switch de dispatch (`:1541`): si flag off → comportamiento actual (voice catch-all/none); si on → `runAssistantForWebhook` como bg task. Exclusión `!hasPendingVoucher` (el contexto voucher corre siempre y es dueño del thread).
- Detección de conversación pegada (antes de `extractBotMessage`):
  - `detectPastedConversation(inboundText)` (nuevo módulo §4): requiere ≥2 líneas con formato `[HH:MM[, dd/M/yyyy]] Nombre: texto`.
  - Si matchea y `!hasPendingVoucher && !hasPendingVoice && !flowConsumed && !interactiveReplyId`:
    - bg task: `text = customerText` (solo líneas del cliente, excluyendo speaker "Vos", unidas en orden) + `\nA nombre de {speaker}` (reusa la regla "a nombre de X" de `parse-order.ts:45`; si speaker es "Vos" no se anexa).
    - `processTextOrder({ text, commit:false, ... })` → propuesta 📋 + "Decí 'confirmar' o 'cancelar'" (`askConfirmMsg`).
    - `saveVoiceContext` + `sendVoiceResponse` (igual que `handleVoiceText`).
    - Al "confirmar" del cliente (mensaje normal) → pasa por `hasPendingVoice → voice` → `createPresupuesto` real en FacBal + `sendBudgetImage`. Cero cambios en el pipeline de pedidos.
  - Log `pasted_conversation` en `router_logs`.
- `sendBudgetImage` requiere `NEXT_PUBLIC_BASE_URL` (ya lo usa `route.ts:727`).

### 4. Detección de bloque pegado — `src/lib/voice-orders/pasted-conversation.ts`
- `detectPastedConversation(text): { customerText: string; speaker: string } | null`.
- Regex por línea: `^\s*\[(\d{1,2}:\d{2}(?:[^\]]*))\]\s*([^:]+):\s*(.+)$` — requiere ≥2 líneas que matcheen (evita falsos positivos tipo "Saludos: ..." en una línea).
- `customerText` = contenido de todas las líneas del cliente (speaker ≠ "Vos") en orden cronológico.
- `speaker` = nombre del emisor de la última línea del cliente (más reciente). Si todas fueran "Vos" → `null`.

### 5. Config flag — `assistantEnabled`
- Migración `supabase/migrations/046_ai_config_assistant_enabled.sql`: columna `assistant_enabled boolean default true` en `ai_config` (label del rollout: on por defecto, off reversible por cuenta).
- Exponer en `loadAiConfig` (`src/lib/ai/config.ts`) y tipar (extender el tipo de config). El toggle por cuenta ES el rollback. (Edición en la UI de settings no entra en alcance.)

### 6. Tests
- `src/lib/voice-orders/pasted-conversation.test.ts`: ambos lados, un solo lado, single-line no es paste, all-"Vos" → null, extracción de speaker.
- Router (`src/lib/bot/router.test.ts`): `otro`→assistant sin pendings; `otro` + `hasPendingVoice`→voice; confirm "si" con pendingInvoice→voice; `pedido` alta→voice; expense/attendance/voucher sin cambios.
- Wrapper producción (`production.test.ts`): flag off sin send; thread con agente asignado sin send; `ai_autoreply_disabled` sin send; sin reply → fallback a auto-reply.
- Suite existente (711) intacta.

### 7. Verificación
- `npm run lint` (0 errores) → `npm run typecheck` → `npm test`.
- Manual en producción/sandbox: pegar un bloque real de WhatsApp → propuesta → "confirmar" → chequear presupuesto en galv2-tauri + imagen recibida por WhatsApp.
- CI verde tras el push.

---

## 3. Archivos tocados

| Archivo | Cambio |
|---|---|
| `src/lib/bot-beta/voucher-dryrun.ts` | fix lint :52 |
| `src/lib/voice-orders/synonyms.ts` | fix lint :70 |
| `src/app/api/bot-beta/unified/route.ts` | fix lint :35,39,51,107 |
| `src/app/api/whatsapp/webhook/route.ts` | fix lint :1538-1539 + caso `assistant` + integración bloque pegado |
| `src/lib/bot/router.ts` | `assistant` + `hasPendingVoice` + guard confirmación |
| `src/lib/bot-assistant/production.ts` | **nuevo** — `runAssistantForWebhook` |
| `src/lib/bot-assistant/orchestrator.ts` | args aditivos `{ knowledge, readonlyExpensePreview }` |
| `src/lib/ai/knowledge.ts` / `src/lib/ai/context.ts` | reutilizados (sin cambios o menores) |
| `src/lib/voice-orders/pasted-conversation.ts` | **nuevo** — detección de bloque pegado |
| `src/lib/ai/config.ts` | expone `assistantEnabled` |
| `supabase/migrations/046_ai_config_assistant_enabled.sql` | **nuevo** — columna flag |
| Tests (§6) | **nuevos/ampliados** |

## 4. Riesgos / notas
- Voice aúdio y pedidos de texto actuales quedan intactos (solo se suma el asistente para lo no consumido y el atajo del bloque pegado).
- El guard `hasPendingVoice` es la pieza que evita que el asistente robe la confirmación de un presupuesto.
- `readonlyExpensePreview` evita crear categorías fantasma en FacBal desde el asistente.
- Rollback: revert del commit (cambios aditivos en webhook/router) o flag off por cuenta.
- Fuera de alcance: `/bot-escalations`, UI de settings para el flag, edición de la plantilla de imagen del presupuesto.