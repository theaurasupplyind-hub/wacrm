# Plan: Mejora del asistente de WhatsApp — diagnóstico de logs + fixes

> Para un agente implementador. **Estado:** planificado — no iniciado.
> Basado en análisis de logs reales en Supabase (`router_logs`, `bot_traces`,
> `voucher_extractions`) y en una comparativa de modelos con visión.
> Contexto: `docs/bots/architecture.md`, `resumen-bot-beta.md`,
> `docs/bots/plan-unificacion-motor-bot.md`.

## Decisiones tomadas (confirmadas)

- El **pipeline determinístico** (gastos/asistencia/vouchers) es bueno: los problemas son de **UX** (mensajes, silencios), no de backend.
- **Whitelist de números**: tabla **nueva** `bot_allowed_numbers`. Solo algunos números pueden hablarle al bot. El resto (clientes) sigue por Flows / AI auto-reply.
- **Números no autorizados: ignorar** (no responder nada).
- **Orden de prioridad**: 1) whitelist → 2) nunca-mudo → 3) vouchers → 4) razonamiento → 5) observabilidad.
- **Probar DeepSeek** (piloto, visión) antes de cambiar producción.
- Escrituras sin confirmación: solo las actuales. Las nuevas nacen con confirmación.

---

## 1. Hallazgos de logs (evidencia)

Muestra: 277 turnos recientes de `router_logs`; 500 de `source`.
- `dispatched_to`: `expense 106 · assistant 55 · none 45 · voucher 29 · attendance 25 · flow 10 · voice 4 · clarify 3`.
- `source`: `text 141 · image 89 · interactive 18 · document 15 · assistant 14`.
- `extractor_source`: `llm 170 · (vacío) 104 · fallback 3`.

### 1.1 Silencios (`dispatched_to=none`) — "se traba"
- **45 turnos sin respuesta.** 42 son `source=image` (imágenes que no son voucher ni gasto) → caen a `none`. 3 son texto `"cancelar"`/`"Cancelar"` con contexto pendiente.
- Causa: `decideDispatch` (`src/lib/bot/router.ts`) devuelve `none`; el webhook (`case 'none'`) no responde nada.
- Impacto: el usuario manda algo y el bot queda mudo.

### 1.2 Logs duplicados
- Cada turno del asistente genera **2 filas** en `router_logs`: una del webhook (`logRouterDecision`, `replyPreview` vacío) y otra de `src/lib/bot-assistant/production.ts:147` (con `debug_info`). Infla y confunde el análisis.
- Fix: una sola traza por turno (consolidar en un único `recordBotTrace`/`router_logs`).

### 1.3 Respuestas pobres del asistente
Evidencia (turnos `dispatched_to=assistant`):
- `"quiero ver las boxy fit lisas"` → *"No te entendí 🤔 ¿me repetís?…"* (pide **catálogo/productos**; no existe esa capacidad).
- `"te pido catalogo"` → *"No tengo acceso a eso"*.
- `"Crea una categoria en gastos llamada…"` → *"No tengo acceso a eso"*.
- `"jesusdanielllavesecreta"` → *"No tengo acceso a eso. Pero te puedo ayudar a armar presupuestos…"* (inconsistente con el prompt).
- Consultas de deuda **funcionan** (`"Cuánto debe ursula?"` → F-10828).
- Causas: (a) faltan capacidades (productos/catálogo); (b) fallback genérico "no entendí" cuando el intent no matchea; (c) prompt inconsistente sobre presupuestos.

> Nota: varios de estos mensajes vinieron de números que **no deberían** tener acceso al bot → refuerza la Fase 1 (whitelist).

### 1.4 Acceso indebido (whitelist)
- Mensajes de números que no son del taller llegaron al bot. **Falta un gate de números autorizados.**

### 1.5 Vouchers con nombre — 37% sin match
`voucher_extractions`: `matched 154 · ambiguous 46 · no_match 40 · multi_invoice 6`.
Causas raíz (del `debug_info`):
- **Bug**: el extractor devuelve `nombre_cliente: "Comprobante.pdf"` (nombre de archivo) y `sanitizeClientName` (`src/lib/ai/voucher-matching.ts:22-39`) **no lo filtra** (solo descarta `"comprobante"` exacto, no `"comprobantepdf"`).
- **Name-match débil** (umbral 0.5 por tokens):
  - `"LUCAS GABRIEL CARDO"` vs `Lucas` (0.23) / `Gabriel Hermida` (0.17).
  - `"Maria Luisa Buceta"` vs `Maria Rey` (0.30).
  - `"Ana Isabel Majdalani"` vs `Ana Mazieres`/`Ana Audivert` (0.175).
- **Colisiones de monto**: `44000` matchea Dario/Mimi/Oporto (score 1); `78000` matchea 4 clientes. El monto no desambigua y el nombre no alcanza.
- `nombre_origen` es el **titular bancario**, que no siempre coincide con el cliente del sistema.
- Nota: `voucher_pending_reviews` (nombres completos extraídos) vive en la DB de `backend_gal`, no en el Supabase de `wacrm`.

---

## 2. Modelos LLM con visión — comparativa de costos

| Modelo | Modalidad | Precio in/out (1M) | Notas |
|---|---|---|---|
| `deepseek/deepseek-v4.1-flash` | texto+imagen | $0.30 / $1.20 | Nativo, **no experimental**, ctx 1.05M |
| `deepseek/deepseek-v4-flash-vision-exp` | texto+imagen | $0.216 / $0.647 | Experimental |
| `deepseek/deepseek-v4-flash-0731` | solo texto | $0.018 / $0.320 | Muy barato para extracción/parseo |
| *(actual)* `gemini-2.5-flash` | visión | ~$0.30 / ~$2.50 | Vouchers |
| *(actual)* `gemini-2.5-flash-lite` | texto | ~$0.075 / ~$0.30 | Extractor/parseo |
| *(actual)* `openai/whisper-1` | audio | por minuto | Transcripción |

Recomendación: **piloto A/B de visión** con `deepseek-v4.1-flash` para vouchers, con el golden set, **antes** de cambiar producción. Config en `src/lib/ai/openrouter.ts` + env `VOUCHER_AI_MODEL` / `ASSISTANT_MODEL`. Rollback por env.

---

## 3. Fases de implementación

### Fase 1 — Whitelist de números (prioridad)
- **Tabla nueva** (migración Supabase): `bot_allowed_numbers`
  - `id`, `account_id uuid`, `phone text` (normalizado), `label text`, `active boolean default true`, `created_at`.
  - Índice único `(account_id, phone)`.
  - RLS: `is_account_member` para lectura; service-role para escritura.
- **Gate** en `src/app/api/whatsapp/webhook/route.ts`: el bloque del bot (gastos/asistencia/voucher/asistente) solo corre si `message.from` está en la whitelist (activa). Si no → **ignorar** (no responder).
  - Flows / AI auto-reply de clientes **no se tocan**.
- Gate equivalente en `/api/bot-beta/*` y dentro de `runAssistantForWebhook`.
- Seed inicial: números del taller (pedir al dueño).
- UI mínima (luego): settings para administrar números.

### Fase 2 — Nunca mudo (UX)
- `case 'none'` en el webhook: si hay texto/imagen no consumida (de número autorizado) → responder algo útil (pedir texto, o "no pude leer la imagen, mandame el detalle").
- `"cancelar"` global: manejar cancelación en cualquier contexto pendiente (expense/attendance/voucher), no solo clarify.
- Garantía: ningún mensaje de un número autorizado termina sin respuesta.

### Fase 3 — Vouchers
- Filtrar nombres basura: `sanitizeClientName` debe descartar filenames/extensiones y palabras genéricas (`comprobantepdf`, `.pdf`, `.jpg`, etc.).
- Mejorar name-match: tokens + apellidos, umbral calibrado, normalización; usar `nombre_origen`/`nombre_destino` y caption.
- Caption como **preferencia fuerte** (ya existe `preferByCaption`): si el usuario escribe "son de X", priorizar X.
- Ante ambigüedad: **preguntar el cliente** con botones (flujo ya existe) en vez de quedar en `ambiguous` sin respuesta.
- Ajustar el prompt de `voucher-extraction.ts` para no devolver filename como nombre.

### Fase 4 — Calidad de razonamiento del asistente
- Modelo compartido (piloto DeepSeek V4.1 Flash) + bajar latencia.
- Nuevas capacidades: catálogo/productos (lectura), resolución de entidades.
- Tool-calling por defecto (hoy detrás de `ASSISTANT_TOOLS_ENABLED`).
- Reforzar prompt anti-alucinación y de "qué puedo hacer" (sin prometer presupuestos si no está).

### Fase 5 — Observabilidad y evaluación
- Fix de logs duplicados (una traza por turno).
- Tablero de "silencios" (`none`), `no_match`, `ambiguous`.
- Arnés de evaluación (`src/lib/bot-llm/eval.ts` + golden set) ampliado con casos reales de `router_logs` y `voucher_extractions`.

---

## 4. Archivos a tocar
| Archivo | Cambio |
|---|---|
| `supabase/migrations/050_bot_allowed_numbers.sql` | **nueva** — whitelist |
| `src/app/api/whatsapp/webhook/route.ts` | gate whitelist; `case 'none'`; cancelar global; log único |
| `src/lib/bot/router.ts` | revisar ramas `none` |
| `src/lib/bot-assistant/production.ts` | log único; capacidades; prompt |
| `src/lib/ai/voucher-matching.ts` | `sanitizeClientName`, name-match, umbral |
| `src/lib/ai/voucher-pipeline.ts` | fase 3 / preguntar cliente |
| `src/lib/ai/voucher-extraction.ts` | prompt (no filename como nombre) |
| `src/lib/ai/openrouter.ts` + envs | modelo piloto |
| `src/lib/bot-assistant/tool-registry.ts` / `prompts.ts` | catálogo, capacidades |
| `src/lib/bot-llm/eval.ts` + fixtures | golden set real |

## 5. Verificación
- `npm run lint` · `npm run typecheck` · `npm test` · `npm run build`.
- E2E WhatsApp (número autorizado vs no autorizado): silencio esperado para no autorizado; nunca-mudo para autorizado.
- Vouchers: reprocesar los `ambiguous`/`no_match` del log y medir mejora del match rate.
- A/B del modelo sobre golden set.

## 6. Riesgos
- Whitelist mal configurada → el bot deja de responder a números válidos (mitigar con seed + logs).
- Cambiar el modelo puede degradar extracción (mitigar con A/B y rollback por env).
- El name-match agresivo puede asignar el pago a la factura equivocada (mantener confirmación ante baja confianza).

## 7. Pendientes de datos
- Seed de números autorizados del taller.
- 3-5 ejemplos reales de vouchers con nombre donde se equivocó (imagen + caption) para el golden set.
