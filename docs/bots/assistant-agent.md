# Asistente de WhatsApp y evolución a agente

> **Estado del código:** agente con tools activo; el router y los handlers
> transaccionales siguen siendo determinísticos. Desde Fase 3-5 existe además un
> **planner LLM opt-in** (`src/lib/bot/planner.ts`) que reusa este agente y
> propone acciones al motor de turno (default `off`; ver abajo).
> **Modelo:** selección actual depende de envs de Vercel; el piloto DeepSeek
> descrito abajo no está confirmado como desplegado.

Arquitectura general: [`architecture.md`](./architecture.md) §6. Este documento
describe el asistente interno de Bastidores GAL; no es el AI Auto-Reply
configurable por cuenta para responder a clientes.

## Flujo en producción

1. El webhook persiste el mensaje y verifica si el remitente está autorizado
   (`bot_allowed_numbers`). Las respuestas interactivas pendientes y ciertos
   medios se resuelven en sus handlers.
2. Para texto/audio transcrito, `extractBotMessage()` produce una extracción
   estructurada y el router resuelve `gasto`, `asistencia`, `voucher`, `pedido`,
   `factura` o `assistant`.
3. Solo los mensajes que llegan a `assistant` llaman a
   `runAssistantForWebhook()`. **El agente no decide actualmente el dispatch
   global ni sustituye los handlers determinísticos.**
4. En producción se carga historial reciente y conocimiento de la cuenta. El
   loop de `runAssistantAgent()` selecciona tools, recibe sus resultados y
   redacta la respuesta. Se ejecuta por defecto; poner
   `ASSISTANT_TOOLS_ENABLED=false` usa el orquestador anterior.

El handler de pedidos distingue **cotizar** de **crear**: una consulta produce
un preview y ofrece iniciar el presupuesto; crear requiere una instrucción clara
y una confirmación antes de escribir en FacBal. La creación usa los defaults
del programa (`Retira`, sin fecha, sin descuento) y solo pregunta por el cliente
si falta.

La cancelación global (`cancelar`, `no lo creas/era una prueba`, `reiniciar`)
también limpia `order_context`. Las respuestas a los slots de cliente no aceptan
el teléfono del remitente ni frases de conversación como nombre.

Archivos principales:

| Archivo                                  | Responsabilidad                                            |
| ---------------------------------------- | ---------------------------------------------------------- |
| `src/app/api/whatsapp/webhook/route.ts`  | Extracción, contexto pendiente, clarify, dispatch y gates  |
| `src/lib/bot/router.ts`                  | Selección del handler según intent, confianza y pendientes |
| `src/lib/bot-assistant/production.ts`    | Gates productivos, historial/KB, invocación y envío        |
| `src/lib/bot-assistant/agent.ts`         | Loop LLM ↔ tools                                           |
| `src/lib/bot-assistant/tool-registry.ts` | Contratos y ejecución de herramientas                      |
| `src/lib/bot-llm/context.ts`             | Representación textual de contextos de dominio pendientes  |

## Herramientas y límites actuales

La **fuente de verdad** del catálogo es `src/lib/bot-assistant/tool-registry.ts`
(`agentToolDefinitions()`). Hoy expone **18 tools**:

- **Lectura:** `consultar_facturas`, `listar_gastos`, `buscar_proveedores`,
  `buscar_empleados`, `listar_categorias`, `buscar_productos`,
  `consultar_asistencia`, `consultar_estado_pedido`,
  `consultar_confirmaciones_pendientes`, `consultar_ultima_escritura`.
- **Cotización:** `cotizar_pedido` genera un preview; **no** crea por sí misma un
  presupuesto.
- **Escritura (delegada a los handlers que confirman):** `registrar_gasto`,
  `registrar_asistencia`, `editar_gasto`, `eliminar_gasto`,
  `eliminar_asistencia`, `deshacer_ultima_operacion` (undo 24 h).
- **Ayuda:** `pedir_ayuda`.
- **Vouchers:** siguen en su pipeline separado y **no** se exponen como tool del
  agente.
- **Presupuestos:** las consultas no crean registros; el flujo de creación vive
  en `src/lib/pedidos/` y confirma antes de ejecutar.

La búsqueda del cliente es por nombre, no por el teléfono interno del remitente.
Nombres que son solo teléfonos o etiquetas genéricas como `Cliente 549...` no
se proponen; el número del dueño tampoco se escribe en el cliente ni en el
presupuesto.

`tool-registry.ts` marca algunas tools con `write: true`. Desde **Fase 5**, la
barrera de escritura del **planner** vive en `src/lib/bot/policy.ts`
(`applyPolicy`: tope 1 escritura/turno, texto del usuario obligatorio, dedupe) y
en `reconcilePlans` (las escrituras del planner requieren
`ASSISTANT_PLANNER_WRITES=true`). El loop del **asistente** sigue ejecutando las
tools de escritura sólo a través de los handlers que confirman; no se amplió su
autonomía.

## Planner del motor de turno (Fases 3-5)

El planner es el mismo agente, reutilizado como **planificador**: en vez de
responder al usuario, propone `TurnAction`s que el motor valida.

- Archivo: `src/lib/bot/planner.ts`. Reusa `buildAgentMessages()` (prompt/tools
  del agente) con `PLANNER_SYSTEM_PROMPT` y `agentToolDefinitions()`.
- Mapea tool calls a acciones (`registrar_gasto` → `run_expense`, etc.). **No
  lee los argumentos del modelo**: los montos/IDs salen del texto del usuario y
  de los handlers.
- Modos: `ASSISTANT_AGENT_PLANNER=off|shadow|on` (default `off`). `shadow` corre
  y **sólo registra** (comparación con el determinístico); `on` puede conducir,
  limitado por `ASSISTANT_PLANNER_DOMAINS` y `ASSISTANT_PLANNER_WRITES`.
- `reconcilePlans()` (en `engine.ts`) aplica los guardrails: vouchers congelados,
  clarify/pendientes protegidos, dominio habilitado y policy de escrituras.
- Observabilidad: `router_logs.debug_info.planner_shadow` (`agrees`,
  `unnecessaryWrite`, `missedWrite`, `latencyMs`, `drive.source/reason`) y una
  traza en `bot_traces` (producer `planner-shadow`).

Rollout sugerido: `shadow` → `on`+`assistant` (lectura) → `+pedido` →
`+expense` → `+attendance` → `ASSISTANT_PLANNER_WRITES=true`. **Vouchers** no
entran al planner.

## Contexto: lo que recuerda y lo que no

- `buildConversationContext()` carga mensajes de texto recientes desde la
  conversación: 20 por defecto, ajustable con `AI_CONTEXT_MESSAGE_LIMIT`.
- `buildAgentMessages()` preserva los roles `user`/`assistant`, limita el
  prompt a 20 mensajes incluyendo el actual y no duplica el mensaje entrante si
  ya está persistido.
- El webhook pasa la `UnifiedExtraction` y el estado multi-turno construido por
  `buildBotContextText()` como pistas. Se presentan explícitamente como datos
  que pueden equivocarse; el texto original y el resultado de las tools son la
  fuente de verdad.
- Gastos, asistencia, vouchers, pedidos y clarify mantienen estados separados.
  No hay todavía un resumen durable de preferencias/hechos del usuario ni una
  memoria unificada entre conversaciones. Por eso “más contexto” no equivale a
  memoria ilimitada.

## Modelos y configuración

El cliente de estas llamadas usa OpenRouter (`OPENROUTER_API_KEY`); el código
actual no usa el endpoint de Vercel AI Gateway para este flujo.

| Variable                  | Alcance                                        | Default en código                                             |
| ------------------------- | ---------------------------------------------- | ------------------------------------------------------------- |
| `ASSISTANT_MODEL`         | Loop de tools y respuesta del asistente        | `google/gemini-2.5-flash-lite` vía default de `openrouter.ts` |
| `EXTRACTOR_MODEL`         | Extracción/ruteo del webhook                   | `google/gemini-2.5-flash-lite`                                |
| `VOUCHER_AI_MODEL`        | Voucher y extracción multimodal de gastos      | `google/gemini-2.5-flash`                                     |
| `ASSISTANT_TOOLS_ENABLED` | Selecciona loop nuevo vs. orquestador anterior | Loop activo salvo valor exacto `false`                        |

### Piloto acordado: DeepSeek solo para texto/agente

Usar en **Preview** con OpenRouter:

```env
ASSISTANT_MODEL=deepseek/deepseek-v4.1-flash
EXTRACTOR_MODEL=deepseek/deepseek-v4.1-flash
```

Mantener `VOUCHER_AI_MODEL=google/gemini-2.5-flash` durante esta prueba. No
afirmar que el piloto está activo hasta confirmar las envs, el redeploy y una
prueba en el entorno. Comparar los mismos casos con el modelo anterior: español
rioplatense, contexto corto/multi-turn, clasificación, extracción JSON,
selección de tool, respuesta grounded, fallos, latencia y coste. Habilitar
producción solo tras revisar regresiones y conservar rollback por env.

### Resultado del piloto (2026-10-14, Fase 5) — NO cambiar

38 fixtures (`agente-fixtures.ts`) + 5 respuestas (`respuesta-eval.live.test.ts`):

| Métrica (extractor) | Gemini 2.5 Flash Lite | DeepSeek v4.1 Flash |
|---|---|---|
| Intent accuracy | 34/38 (89.5%) | 35/38 (92.1%, dentro del ruido ±1) |
| Fallback regex | 0/38 | 1/38 |
| Costo/caso | $0.00050 | $0.00054 (+8%: input más barato, output 3x) |
| Latencia p50/p95 | 1330/2795 ms | 2309/10804 ms |

Respuestas: rioplatense correcto en ambos; DeepSeek más verborrágico y
conservador ("¿Lo registro?" donde el prompt pide confirmar registrado —
fricción extra para auto-save, requeriría retunear el prompt por modelo).

**Decisión: se mantiene Gemini Flash Lite** en extractor y agente. DeepSeek no
pasa la regla (calidad ≈ igual, costo mayor, p95 4x). Re-evaluar si cambian
precios o sale versión más rápida. Harness reutilizable: `agente-eval.live`
(costo/latencia) + `respuesta-eval.live` (rúbrica humana).

## Siguiente evolución sin cambiar capacidades existentes

1. Ejecutar y documentar el piloto de modelo; guardar ejemplos fallidos y
   esperados.
2. Mejorar continuidad/manejo de contexto usando el historial y estados
   existentes; no reemplazar handlers ni saltarse clarify/confirmaciones.
3. Caracterizar con fixtures que las operaciones actuales siguen llamando a
   las mismas tools y handlers, y que el texto de la respuesta está grounded.
4. Añadir la política runtime de escritura antes de permitir nuevas acciones.
5. Solo después evaluar que el agente asuma más decisiones de planificación,
   primero en paralelo/sombra y sin ejecutar escrituras duplicadas.

El objetivo es que el LLM entienda mejor palabras, referencias y continuidad,
sin convertirlo en autoridad sobre reglas contables ni alterar el comportamiento
transaccional que hoy funciona.
