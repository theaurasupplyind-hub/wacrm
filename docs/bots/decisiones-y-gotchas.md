# Decisiones y gotchas — ecosistema de bots

> Documento de rescate. Consolida las decisiones de diseño, incidentes y trampas
> que estaban dispersas en planes ya archivados o superados. Cuando un plan se
> archiva, lo único que debe seguir vivo en la documentación vigente llega acá.
>
> Origen de cada bloque: el plan que lo documentó por primera vez (hoy en
> `archive/` o `plans/`). Estado: **vigente** salvo que se indique lo contrario.

## 1. Backend e integración (FacBal API / `backend_gal`)

- **`asistencias` (asistencia):** una fila por **empleado + día** y **un solo
  `status`**. `POST /attendance` es **upsert**: si la fila existe y llega
  `exit_time`, se setea sin pisar `status`. `exit_time` es una columna nullable.
  No pensar en múltiples eventos por día. *(origen: `archive/plan-mejora-gastos-asistencia.md`)*
- **`verify_api_key` es no-op si `FACBAL_API_KEY` no está seteada** → hoy casi
  todos los endpoints del backend están **sin auth efectiva**. `verify_station_key`
  sí exige `X-Api-Key`. Cualquier endpoint nuevo (p. ej. `/assistant/run`) necesita
  auth propia; no confiar en `verify_api_key`. *(origen: `plans/plan-automatizacion-chat-y-asistente-desktop.md` Anexo A)*
- **CORS:** `allow_origins=["*"]` + `allow_credentials=True` (combinación inválida
  en navegadores con credenciales).
- **Migraciones:** no usa Alembic; `Base.metadata.create_all` + `run_db_migrations()`
  con `ALTER ... IF NOT EXISTS` dentro de un `try/except` que **traga errores**
  (solo imprime "Migration Warning"). No depender de ese camino para cambios reales.
- **LLM/HTTP en endpoints `def`:** `requests` bloquea el worker → usar
  `run_in_threadpool` o `httpx.AsyncClient`.
- **Domicilios de cliente:** el padrón tiene múltiples direcciones + una
  predeterminada (`GET /clients/{cid}/addresses`, `set_default_address`). galv2
  guarda `ultimo_tipo_entrega` por cliente → mejor default que `'Retira'` fijo.

## 2. Precios (motor local vs backend)

- **NUNCA encadenar `suggest-price` (backend) con `bulk-price`.** El backend
  aplicaría dos veces la `pricing_rule` → **doble conteo** (p. ej. el +10% de
  pintura). El bot usa **un único motor**.
- galv2-tauri **no** llama a `bulk-price`/`suggest-price`: hace el pricing
  **client-side** en `precios.ts`. El `bulk-price` del backend es un **espejo
  imperfecto**; ante discrepancia, manda el motor local.
- **Redondeo de medidas** (`roundDim`): múltiplo de 10; unidad 0–3 baja, 4–9 sube.
  Si no hay medida exacta → se resuelve por **perímetro más cercano**
  (`nearestStandard`, `calcPriceByPerimeter`).
- **`satori` (`@vercel/og`) no soporta `<table>`** → la tarjeta de recibo se
  construye con flexbox.
- *(origen: `archive/plan-presupuestos-por-bot.md`)*

## 3. Extracción unificada y routing de intents

- Contrato de `extractBotMessage` (`src/lib/bot-llm/`): devuelve intent +
  campos estructurados + `faltan_campos` (lo que el mensaje NO aporta) +
  `dudoso` (monto ambiguo, dos montos candidatos, categoría dudosa…). `dudoso`
  activa confirmación interactiva en vez de auto-guardar.
- **Grietas conocidas del fallback regex** (ya mitigadas, pero conviene no
  reintroducirlas):
  - `looksLikeExpense("transferí para la factura 001")` = `true` → el gasto se
    come un voucher.
  - `looksLikeExpense("compré 3 bastidores 60x40")` = `true` → un pedido se
    interpreta como gasto.
  - `looksLikeAttendance("se fue la luz")` = `true` (keyword `se fue`) → un
    problema del local se interpreta como salida de empleado.
- *(origen: `archive/plan-bot-llm-unificado.md`)*

## 4. Pedidos e ítems fuera de catálogo

- **`DEFAULT_CATEGORIA = 'BASTIDOR'` es la causa raíz de la alucinación de
  ítems.** Un nombre de producto sin medida y sin categoría conocida **NO es un
  bastidor**. *(origen: `archive/plan-items-libres-y-creacion-corta.md`)*
- **Ítem libre = línea manual:** se cotiza con el nombre que dio el usuario y **su
  precio** (puede ser `0`). Sin precio → se pregunta ese precio una vez; si no
  contesta, queda "a cotizar a mano" (excluido del total).
- **Nunca** convertir un ítem libre en bastidor por la aparición posterior de una
  medida.
- **Heurística producto vs modificador:** 2+ palabras no reconocidas y **ninguna
  medida** → ítem libre; **1 palabra** junto a un producto reconocido → término de
  glosario.
- **Creación corta:** un solo mensaje pide cliente + envío/retiro (fecha, domicilio,
  descuento son opcionales y se **asumen**: sin fecha, sin descuento, domicilio del
  padrón si es envío). Obligatorio: **cliente + tipo de entrega**.
- **Ítems con precio propio** viajan en `ParsedOrderItem.precio` y `PedidoItem.libre`.

## 5. Asimetría confirmar / cancelar (detección sí/no)

- Cancelar usa `some` (una palabra basta si no hay resto); confirmar usa `every`
  (una palabra de más lo invalida) → `"si + [verbo]"` moría.
- **Enclíticos** rompen los verbos: `convertila / conviertela / hacelo / armalo /
  crealo / cotizalo`. Ya cubiertos en `RESTATE_VERBS`
  (`src/lib/bot-llm/reply-intent.ts`).
- **Regla correcta:** confirmar si hay palabra de confirmación **y** el resto es
  solo relleno o verbo que **repite la oferta** ("si conviertela", "dale hacelo");
  si hay contenido nuevo (números, "pero", cambios) → corrección.
- **Ojo:** el test `pending-confirm.test.ts` fija que
  `"sí pero cambiá el monto a 20"` **NO** es confirmación. La regla debe respetarlo.
- *(origen: `archive/notas-fallos-reales.md`)*

## 6. Orquestador LLM + bots rígidos — guards (incidente 15/10/2026)

Conversación real `05fe8f78…`: el asistente **inventó** un presupuesto (copió el
formato del flujo y metió "Pachecho" del pedido anterior) y `"no"` **borró** el
`order_context`. Dos fallas, misma raíz: cuando el mensaje se sale del camino
programado, o se descarta en silencio o lo agarra el asistente y lo inventa.

**Principios:** el LLM orquesta, los bots ejecutan; estado **fresco** (nunca del
historial); re-llamar al bot del dominio en vez de improvisar; **nunca afirmar lo
que no se hizo** sin `handled:true` / escritura confirmada.

**Guards vigentes:**

| Guard | Regla |
|---|---|
| **G1 sticky** | Con `order_context` presente (abierto **o** cancelado-reanudable) el dispatch va a `pedido`. Cancelar **no borra**: marca `quoteCancelled` y conserva ítems/`quoteText`. |
| **G2 delegación** | El orquestador no ejecuta escrituras: propone y el runtime delega en el bot. Sin `handled:true`, no hay afirmación. |
| **G3 no-formato** | Prohibido emitir literales del flujo (`"Voy a armar este presupuesto:"`, `"Cliente nuevo:"`, `"Cotización estimada:"`, `"¿Confirmás?"`, `"Presupuesto P-…"`). Guard de salida + test. |
| **G4 cliente** | El cliente sale **solo** de `searchCandidates(nombreDelMensaje)`, nunca del historial ni del LLM. |
| **G5 anti-repetición** | Si el mensaje no cambia el estado, **no** re-mostrar el mismo bloque: responder "no pude aplicar X". |
| **G6 idempotencia** | La delegación registra en `bot_write_log`; doble ejecución del mismo mensaje no duplica. |

*(origen: `plans/plan-orquestador-llm-bots-rigidos.md`; Fase 8 —planner `on` por
dominio— sigue como rollout)*

## 7. Asistente productivo — límites de escritura

- **`readonlyExpensePreview`** en producción: el preview de gasto **no crea
  categorías** en FacBal (`resolveExpenseCategory` → `categoryId:null, created:false`).
  Evita categorías fantasma desde el asistente. *(origen: `archive/plan-bot-beta-a-produccion-asistente.md`)*
- **Guard `hasPendingVoice`:** si hay un pedido/presupuesto pendiente, el dispatch
  va al bot de pedidos **antes** que a cualquier rama del asistente, para que el
  `"si"`/`"dale"` posterior a una propuesta siga confirmando el presupuesto y no lo
  robe el asistente.
- **Escrituras del agente:** pasan por los handlers que confirman; la barrera de
  escritura del **planner** vive en `src/lib/bot/policy.ts` (máx. 1 escritura/turno,
  texto del usuario obligatorio, dedupe) y `reconcilePlans`.

## 8. Jev — DESCARTADO (decisión 2026-10-17)

Se evaluó usar Jev (TypeSafe System One) como clasificador auxiliar de intent y de
pendientes. **Decisión: descartado** — la mejora de clasificación se resuelve por
datos, no por un modelo extra. El spike validó el endpoint y la mecánica; se conserva
el aprendizaje por si se retoma:

- Endpoint **`POST https://openrouter.ai/api/alpha/decisions`** (no
  `/chat/completions`), con `{ model, state, questions }`.
- **Gate de confianza `JEV_OVERRIDE_MIN_CONFIDENCE = 0.6`:** con un gasto pendiente,
  `"quiero 4 bastidores 60x40"` Jev devolvió `gasto` con **0.47** → **no** se
  sobrescribe el intent. Ese caso es la justificación del gate.
- Costo ~$0.00002/llamada; `JEV_ENABLED=false` por defecto (cero cambio de conducta).
- Código existente sin usar: `src/lib/ai/jev.ts` + `src/lib/bot-llm/classify-jev.ts`.

## 9. Deuda de código conocida (no cubierta por estos docs)

- **`src/lib/bot-beta/voucher-dryrun.ts` es una copia manual de
  `src/lib/ai/voucher-pipeline.ts`** ("mantener sync manual si prod cambia").
  Pendiente: parametrizar el pipeline con `mode: 'commit' | 'dryRun'` y eliminarla.
- **Migrar Bot Beta al motor de turno**: `src/lib/bot-beta/unified-handler.ts` sigue
  con orquestación propia; debería pasar a adapter del motor (gana clarify gratis).
- **Idempotencia durable por `metaMessageId`**: hoy la dedupe de escrituras es por
  turno. Ojo: `bot_write_log` solo registra las escrituras de las **tools del
  asistente** (ver §11.4), no las de voucher/pedidos.
- **`pedidos/interpret-modification.ts`** se conserva por compatibilidad (y sus
  tests) hasta que `interpret-changes.ts` cubra sus 3 operaciones con paridad.
- **"Bloque pegado" de WhatsApp** (`voice-orders/pasted-conversation.ts`): quedó
  **especificado pero no implementado** (el módulo `src/lib/voice-orders/` fue
  retirado). Decisión de producto pendiente: implementar o descartar.
- **Cuarto detector sí/no** (`classifyYesNo` en `pedidos/summary.ts`): pendiente de
  unificar a `bot-llm/reply-intent.ts` → **promovido a `plan-01-vocabulario-datos.md`
  Fase A4**.
- *(origen: `archive/notas-fallos-reales.md`,
  `archive/plan-bot-beta-a-produccion-asistente.md`,
  `archive/plan-implementacion-urgente.md`, `archive/resumen-bot-beta.md`)*

## 10. Trabajo pendiente heredado

- **Piloto de modelo por OpenRouter**: probar DeepSeek en `ASSISTANT_MODEL` y
  `EXTRACTOR_MODEL` (mantener `VOUCHER_AI_MODEL` en Gemini). Harness listo:
  `agente-eval.live` + `respuesta-eval.live`. Sin aplicar/validar en producción.
- **Política runtime de escrituras del agente:** añadir política + pruebas para
  herramientas de escritura **antes** de ampliar su autonomía.
- **Glosario y memoria** → **promovido a `plan-02-glosario-knowledge.md`** (alias
  tipado, producto custom + precio, columna `domain`, vocabulario en el contexto del
  agente).
- **Métricas actuales:** re-correr el análisis de `router_logs` (silencios `none`,
  `no_match`/`ambiguous` de voucher) — los números de los planes archivados son
  históricos.
- **Higiene de CI:** fallas preexistentes en `main` — 2 tests de timezone en
  `dashboard/date-utils.test.ts` y 1 timeout de render en `pedidos/receipt-image.test.ts`.
- **Loop semanal:** `scripts/failure-report.mjs` → fixtures de regresión / prompt /
  vocabulario / umbrales.
- *(origen: `plan-mejora-asistente-whatsapp.md` (eliminado),
  `archive/plan-implementacion-urgente.md`)*

## 11. Incidentes del 16/10/2026 y fixes aplicados

Diagnóstico hecho sobre `router_logs` / `voucher_extractions` en vivo.

### 11.1 Doble procesamiento de un voucher con caption (imagen + texto)

Un mensaje **imagen con caption** se procesaba por **dos caminos**: el pipeline de
media (`processVoucherMessage`, gate pre-turno del webhook) y el motor de turnos
(`run_voucher_text` sobre el caption). Resultado real (conv. Kari, F-10960): **dos
filas de `voucher_extractions` con el mismo `message_id`** (una con la visión del
banco/ref, otra sólo con el caption), una **registró** el pago y la otra **pidió
confirmación** ("Voy a registrar un pago de $35.000,00… ¿Confirmás?").

- La confirmación previa para transferencias por texto la introdujo el commit
  **`49fadcb` (2026-09-08, "transferecnia sin voucher")** —
  `voucher-pipeline.ts` § `askTransferConfirm` (`processVoucherText`).
- **Riesgo real:** si el usuario tocaba "Confirmar", el pending del camino texto
  llamaba `registrarPago` sobre una factura ya pagada → **pago duplicado**.
- **Fix:** el bloque "VOUCHER POR TEXTO / PENDING" del motor
  (`src/lib/bot/engine.ts` `planTurn`) ahora exige `!mediaConsumedByVoucher`: si el
  media lo tomó el pipeline de voucher, el caption es contexto de ESA pieza y no un
  voucher de texto aparte. Test en `engine.test.ts`.

### 11.2 Reglas de precio no aplicables como corrección

El motor **sí** lee las reglas: `getPricingRules()` → `GET /pricing-rules` y
`getPreciosReferencia()` → `GET /precios-referencia`, ambas en `loadCatalog()`
(`pedidos/index.ts`). El fixture de `precios/__fixtures__` es **solo de tests**.

El problema era el **intérprete de cambios**: `interpretQuoteChanges`
(`pedidos/interpret-changes.ts`) sólo conoce las líneas ya cotizadas → cualquier
mención de una regla como corrección ("es Cambio de tela", "Poner tela", "cuanto
está caja fibro 78x56") devolvía `unsupported` con el literal *"no encuentro ese
ítem"* y no re-cotizaba.

- **Fix:** en `handleQuoteApproval` (`pedidos/index.ts`), ante `unsupported` con un
  texto que **nombra una regla del catálogo** (`mentionsKnownRule`: frase completa
  del nombre o un `matchToken` de 4+ letras), se **re-cotiza** con el flujo normal.
  El matcher estricto evita falsos positivos por raíz común ("cambiale" ⇔ "cambio").
- **Pendiente de datos (backend):** `"entelar"` no matchea la regla *Poner tela*
  (su único token es `poner`) → agregar `entelar`/`entelado` a sus `match_tokens`.

### 11.3 Descripción con ruido en la escritura

La descripción **mostrada** y la **persistida** son el mismo campo
(`PedidoItem.descripcion`): `summary.ts` la muestra y `execute.ts` la manda a
`createInvoice`. `buildSuggestionDesc` (`precios/engine.ts`) anteponía el texto
crudo del usuario cuando no lo reconocía → *"Cm con los esquineros atrás 200x140
Sin Tela"*.

- **Fix:** `buildSuggestionDesc` acepta `knownWords` y descarta el prefijo cuando el
  resto **no contiene ninguna palabra del catálogo** (ruido de encabezados). Se sigue
  emitiendo **regla/categoría + medida** (`"Pintura 200 x 140"`,
  `"Bastidor 200 x 140 Sin Tela"`), que es lo que necesita el re-parseo y el
  intérprete de cambios.
- **Por qué NO se recorta a "solo la regla":** `descripcion` se reinyecta como texto
  del ítem (`index.ts` contexto/reproceso/`quoteLines`); sin la **medida** las líneas
  son indistinguibles y el LLM corrige/borra la equivocada
  (`interpret-modification.test.ts`).

### 11.4 `bot_write_log` vacío

El ledger se escribe **solo** desde `bot-assistant/undo-log.ts` (`recordWrite`),
usado por las tools del asistente. Los caminos de **voucher** (`registrarPago`) y
**pedidos** (`executePedido`) **no** registran → no hay undo ni auditoría de esas
escrituras (aunque ya existan 27 pagos por voucher en 14 días). Pendiente de diseño.

