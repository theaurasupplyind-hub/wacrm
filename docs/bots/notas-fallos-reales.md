# Notas de fallos reales (WhatsApp, 14/10/2026)

> Solo anotación — sin cambios de código. Dos incidentes del mismo familiar:
> clasificadores determinísticos que exigen input con forma de keyword.

## Incidente 1 — Cotización vencida + "cancela" → "nada pendiente"

Conversación 1:39–1:40 AM. El bot recordó una cotización ($676.000), el usuario
dijo "no cancela", el bot preguntó "¿cancelo o la dejo?", el usuario dijo
"cancela" y el bot respondió "No tenías nada pendiente. ¿En qué te ayudo?".

**Mecanismo:**
- Turnos "Hola" y "no cancela" fueron al `assistant` (textos generados por LLM,
  ningún template los contiene) → implica `hasPendingOrder = false`.
- `order_context` expira a los 30 min (`pedidos/context.ts:5`,
  `isOrderContextActive`). La cotización era anterior → muerta en estructurado,
  viva solo en historial/prosa del LLM.
- "cancela" matchea `CANCEL_RE` (`bot/context-command.ts:25`, corre antes del
  ruteo) → limpia 5 contextos vacíos → `context-command.ts:86` (string exacto).

**Causa raíz:** dos fuentes de verdad divergidas. El LLM ofrece cancelar lo que
solo existe en prosa; el comando solo borra estructurado. Si el TTL no hubiera
vencido, el turno 3 habría ido a `pedido` → `handleQuoteApproval` → cancelado
con confirmación. El TTL es el pivote.

**Verificación (Supabase):**
```sql
select raw_text, intent, dispatched_to, dispatch_reason, created_at
from router_logs where contact_id = '<id>' order by created_at desc limit 10;
-- esperado: assistant, assistant (+ el cancel por context-command)
select order_context->>'stage', order_context->>'updatedAt' from conversations where id = '<conv>';
-- esperado: updatedAt con >30 min
```

## Incidente 2 — "si conviertela en presupuesto" no avanza (repite cotización)

Conversación 1:44–1:45 AM. Cotización $479.000 presentada → "si conviertela en
presupuesto" → el bot REPITIÓ la cotización → "si" pelado → recién ahí avanzó
(cliente Porke → confirmación → creado). Lo demás (typo "Porke}", "Sí, es",
"si" final) funcionó.

**Mecanismo** (`pedidos/index.ts:999` → `handleQuoteApproval:952`):
- `classifyOrderReply("si conviertela en presupuesto")` (`summary.ts:112`):
  tokens significativos = ["si", "conviertela"]. Confirm exige
  `every(t => CONFIRM_WORDS)` (`summary.ts:124`) y "conviertela" no está →
  `'other'`.
- Escape `isExplicitBudgetCreationRequest` (`index.ts:960`): `CREATE_VERB_RE`
  (`intent.ts:2`) no matchea "conviertela" (exige `convertir|convierte|
  convertime|convertí` + fin de palabra; el enclítico "la" lo rompe).
- `'other'` → `index.ts:975` `presentQuote` → re-presenta la misma cotización.

**Causa raíz:** asimetría confirmar/cancelar + verbos incompletos.
- Cancelar usa `some` (una palabra cancela basta si no hay resto); confirmar
  usa `every` (una palabra de más lo invalida). "si + [verbo]" muere.
- `CREATE_VERB_RE` no cubre enclíticos: conviertela/convertila/hacelo/armalo/
  crealo/lo, formas naturales cuando el usuario repite lo que el bot ofreció.

**Regla correcta (para cuando se toque, NO ahora):** confirmar si hay palabra
de confirmación Y el resto es solo relleno o verbo que repite la oferta
("si conviertela", "dale hacelo"); seguir a corrección si hay contenido nuevo
(números, "pero", cambios). Ojo: el test `pending-confirm.test.ts` ya fija que
"sí pero cambiá el monto a 20" NO es confirmación — la regla debe respetar eso.

## Patrón común (los dos incidentes)

El usuario tiene que hablar con forma de keyword ("si" pelado, "cancelar"
pelado); cualquier formulación natural ("si conviertela…", "no cancela",
"cancelá eso" con contexto vencido) cae en otro camino o en la nada. Es la
fricción que el plan agente-conversacional elimina: en la vía del agente estos
tres turnos se entienden por contexto. Relacionados: TRES detectores de
"cancelar" divergentes (`context-command.ts:25`, `summary.ts:96-100`,
`pending-confirm.ts`) — y un CUARTO sí/no (`classifyYesNo` en `summary.ts:119`,
para "¿Es ese?" del cliente) todavía sin unificar.

## Salida del paradigma (14/10, en vez de más keywords)

`pedidos/interpret-reply.ts`: fast-path por listas (sin costo) y, solo si da
`'other'`, el LLM juzga con el contexto de lo pendiente
(confirm/cancel/other). Fallo del LLM → `'other'` = comportamiento anterior.
Cableado en `handleQuoteApproval` y respuesta genérica pendiente (los dos
puntos del incidente 2); los checks `=== 'cancel'` mid-slot siguen
determinísticos a propósito (un malentendido ahí borraría progreso). Deuda:
`classifyYesNo` sigue por regex.
## Fixes candidatos (después, no ahora)

1. TTL diferenciado: slots 30 min, cotización presentada 24h. ✅ HECHO
   14/10: `awaitingQuoteApproval` → `QUOTE_TTL_MS` (24h) en
   `isOrderContextActive` (`pedidos/context.ts`); resto sigue 30 min.
   Tests en `pedidos/context.test.ts`.
2. Comando `cancela` quote-aware (cotización vencida → "venció, ¿la armo de
   nuevo?" en vez de "nada pendiente"). ✅ HECHO 14/10: `getStaleQuote`
   (`pedidos/context.ts`, recuerda hasta 7 días) + `staleQuote` en
   `handleContextCommand` + cableado en el webhook. Tests en `context.test.ts`
   y `context-command.test.ts`.
3. Unificar detectores de cancelación; simetrizar confirmación
   (`some` + resto-inocuo, con la salvedad del "sí pero…"). ✅ HECHO 14/10:
   módulo único `bot-llm/reply-intent.ts` (vocabulario + `classifyReply` +
   `isDismissCommand`). `summary.classifyOrderReply`, `context-command` y
   `pending-confirm` delegan. "si conviertela en presupuesto" → confirm.
4. Enclíticos en `CREATE_VERB_RE`. ✅ HECHO 14/10 dentro del #3:
   `RESTATE_VERBS` (convertila/conviertela/hacelo/armalo/crealo/cotizalo…)
   en el mismo módulo; el comando global los cubre vía `isDismissCommand`.
5. Marcar expiración en el contexto del asistente (no ofrecer cancelar lo
   vencido, u ofrecer retomarlo). ✅ HECHO 14/10: `buildBotContextText`
   (`bot-llm/context.ts`) distingue activa (igual) / vencida recordable
   ("VENCIDA: no la ofrezcas, ofrecé re-armarla") / muerta (no se menciona).
   Tests en `bot-llm/context.test.ts`.

## Caso 3 — Presupuesto $3.583.000 a Lucas (éxito con gaps, 2:01 AM)

Flujo completo funcionó (cotización → sí → cliente Lucas, desambiguado 1/2 →
confirmación → factura P-10978 correcta). Gaps vs galv2_tauri detectados:

**a) Nunca pregunta tipo de entrega.** Las preguntas existen (`pedidos/
index.ts:353-365`, botones Retira/Envío/Ret+Env) pero la vía quote-approval
pre-llena defaults (`index.ts:963-967`: `tipoEntrega ?? 'Retira'`,
`fechaEntrega ?? ''`, `descuento ?? null`) → `advance()` las ve seteadas y
saltea las preguntas 3/4/5. La factura salió "Retira" sin preguntar. En el
desktop el tipo es botón obligatorio (`Facturacion.svelte:370`: Retira/Envio/
Retiro y Envio) y afecta template de recibo (`receipt.ts:82`), mapa de reparto
(`MapaClientes.svelte`: Retira se excluye del ruteo) y kanban. Dato útil: el
desktop guarda `ultimo_tipo_entrega` por cliente (`Facturacion.svelte:642`) —
mejor default que 'Retira' fijo.

**b) Nunca pregunta fecha de entrega** (mismo mecanismo, default `''`).

**c) Nunca pone domicilio.** El dato EXISTE y llega: `ClientMatch.domicilio`
(`facbal/client.ts:548`), `createInvoice` acepta `cliente_domicilio` (676) y
el recibo lo renderiza (`receipt-data.ts:11`). Pero `OrderContext` solo lleva
`clienteTelefono` (`pedidos/types.ts:64`) y `executePedido` nunca setea
domicilio (`execute.ts:118` solo teléfono). Plomería lista de punta a punta,
falta solo la capa bot. Backend además tiene domicilios múltiples +
predeterminado (`GET /clients/{cid}/addresses`, `set_default_address`,
`main.py:2381/2428/5134`).

**Spec pedida (UX en 2 turnos):** tras la cotización, UN mensaje acotado con
todo lo que falta (entrega + fecha + domicilio solo si hace falta: si hay
predeterminado se propone, si hay varios se listan, si no hay se omite); el
usuario responde TODO en un mensaje ("envío, viernes, al taller de marcos");
el bot lo parsea y crea. Ahorra 2-3 turnos por presupuesto.
