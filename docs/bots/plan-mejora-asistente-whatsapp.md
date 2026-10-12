# Plan: Mejora del asistente de WhatsApp — diagnóstico de logs + fixes

> **Estado (2026-10): parcialmente implementado; no ejecutar como lista de tareas original.**
> Los hallazgos de logs de §1 son una muestra histórica, no métricas actuales.
> Whitelist, fallback conversacional, comando de contexto, tools del agente,
> saneamiento básico de nombres de voucher y trazas ya existen en el código.
> Quedan por validar calidad/cobertura con datos actuales, añadir controles de
> escritura al runtime y ejecutar el piloto de modelo descrito en §2.
> Contexto: `docs/bots/architecture.md`, `resumen-bot-beta.md`,
> `docs/bots/plan-unificacion-motor-bot.md`.

## Decisiones tomadas (confirmadas)

- El **pipeline determinístico** (gastos/asistencia/vouchers) es bueno: los problemas son de **UX** (mensajes, silencios), no de backend.
- **Whitelist de números**: tabla **nueva** `bot_allowed_numbers`. Solo algunos números pueden hablarle al bot. El resto (clientes) sigue por Flows / AI auto-reply.
- **Números no autorizados: ignorar** (no responder nada).
- **Orden de prioridad**: 1) whitelist → 2) nunca-mudo → 3) vouchers → 4) razonamiento → 5) observabilidad.
- Mantener **OpenRouter**. Piloto primero para asistente/extractor; vouchers
  permanecen en Gemini hasta validar el conjunto de imágenes.
- Escrituras sin confirmación: solo las actuales. Las nuevas nacen con confirmación.

> **Modelo aún sin cambiar:** `deepseek/deepseek-v4.1-flash` no está confirmado
> en las envs de Vercel ni validado en producción. No confundir el plan con un
> despliegue realizado.

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

## 2. Piloto de modelo por OpenRouter (pendiente)

El runtime actual llama a OpenRouter (`src/lib/ai/openrouter.ts`); las
variables de Vercel seleccionan el modelo, no cambian el proveedor.

| Variable en Vercel | Piloto propuesto | Estado |
|---|---|---|
| `ASSISTANT_MODEL` | `deepseek/deepseek-v4.1-flash` | Pendiente |
| `EXTRACTOR_MODEL` | `deepseek/deepseek-v4.1-flash` | Pendiente |
| `VOUCHER_AI_MODEL` | Mantener `google/gemini-2.5-flash` | No cambiar en este piloto |

Antes de habilitarlo en producción: cambiar las dos primeras variables en
Preview, redeployar y comparar una muestra fija con Gemini. Evaluar español
rioplatense, clasificación/extracción, selección de herramientas, JSON, errores,
latencia y costo observados en OpenRouter. Mantener rollback por env. Los precios
son dinámicos por modelo/proveedor; consultar la ficha vigente de OpenRouter en
vez de copiar una tarifa histórica a este plan.

---

## 3. Fases de implementación

### Fase 1 — Whitelist de números (**implementada**)
La migración `050_bot_allowed_numbers.sql`, el gate del webhook y la defensa
adicional en `runAssistantForWebhook` están implementados. El gate afecta al bot
interno; Flows/AI Auto-Reply para los demás contactos siguen separados. La
vigencia de los números habilitados es configuración operativa, no trabajo de
código de esta fase.

### Fase 2 — Nunca mudo (UX) (**implementada; revisar métricas actuales**)
El webhook responde ante texto/media no procesados y resuelve comandos
`cancelar`/`reiniciar` antes del extractor; ahora también limpian
`order_context` y reconocen "no lo creas, era una prueba". Revalidar con trazas actuales: la
intención de esta fase es evitar silencios para remitentes autorizados; los no
autorizados se ignoran por diseño.

### Fase 3 — Vouchers (**fixes principales presentes; medir resultado actual**)
El código filtra nombres de archivo/genéricos (`sanitizeClientName`), da
preferencia al caption cuando identifica un candidato, conserva alternativas
cuando no hay match y pregunta/deriva en casos ambiguos. Los conteos de §1 son
anteriores a esos cambios: no inferir la tasa de éxito actual; reprocesar un
conjunto vigente antes de cerrar la fase.

### Fase 4 — Calidad de razonamiento del asistente (**parcial**)
- Catálogo/productos y cotización ya están expuestos en `tool-registry.ts`.
- El handler de pedidos separa cotización preview de creación explícita; omite
  preguntas de entrega/fecha/descuento cuando aplican los defaults del ERP.
- La selección de cliente no usa el teléfono interno para puntuar coincidencias;
  nombres con solo teléfono se rechazan y el remitente no se guarda como teléfono
  del cliente/presupuesto.
- El tool-calling está activo por defecto; `ASSISTANT_TOOLS_ENABLED=false` usa
  el orquestador anterior.
- El agente productivo recibe historial con roles, extracción y estado pendiente;
  ver [`architecture.md`](./architecture.md) §6.
- Pendiente: piloto DeepSeek según §2 y evaluación con conversaciones reales.
- Pendiente de seguridad: el loop aún no aplica una política runtime a
  `tool.write`; no ampliar acciones de escritura hasta validarla.

### Fase 5 — Observabilidad y evaluación (**parcial**)
- `router_logs` y `bot_traces` registran/enriquecen el turno productivo.
- Se mantienen harness/fixtures de replay; falta una comparación actual A/B y
  reporte periódico de `none`, `no_match` y `ambiguous`.

---

## 4. Trabajo restante (no repetir cambios ya hechos)
| Archivo | Cambio |
|---|---|
| Env de Preview (`ASSISTANT_MODEL`, `EXTRACTOR_MODEL`) | A/B de DeepSeek vía OpenRouter; dejar Voucher en Gemini |
| `src/lib/bot-assistant/agent.ts` / tools | Añadir política runtime y pruebas para herramientas de escritura antes de ampliar autonomía |
| `src/lib/bot-llm/eval.ts` + fixtures/replay | Incorporar casos actuales y medir A/B por calidad, coste y latencia |
| Dashboard/logs | Resumen actual de silencios, `no_match` y `ambiguous` |

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
- Confirmar que los números autorizados de producción siguen correctos.
- Casos actuales de errores de voucher y conversaciones ambiguas para el golden set.
- Confirmar cambio de envs únicamente en Preview; producción permanece sin cambio hasta aprobar la comparación.
