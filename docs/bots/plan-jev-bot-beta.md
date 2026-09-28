# Plan — Jev (TypeSafe System One) como auxiliar del bot

> Estado: **implementado** (Fase 0/1/2 + tests). Pendiente: cargar
> `OPENROUTER_API_KEY` y correr el spike real + shadow de 10 días.
> Modelo: `typesafe/jev-1.13` vía OpenRouter Decisions API.
> Objetivo: mejorar **A) clasificación de intent** y **B) ruteo de respuestas a
> pendientes** (bug "se queda esperando y no responde"), sin borrar el pipeline
> actual. Todo cae al comportamiento viejo ante error/timeout/flag off.

## Cómo activar (10 días)

```bash
# .env  (o .env.local en deploy)
OPENROUTER_API_KEY=sk-or-...     # requerido (misma key que el LLM)
JEV_ENABLED=true
JEV_SHADOW=true                  # días 1-2: corre y loguea, NO decide
JEV_MODEL=typesafe/jev-1.13
JEV_TIMEOUT_MS=4000
```

- Días 3-8: `JEV_SHADOW=false` → Jev decide intent y ruteo de pendientes.
- Rollback: `JEV_ENABLED=false`.

### Archivos

| Archivo | Rol |
|---|---|
| `src/lib/ai/jev.ts` | cliente `/alpha/decisions` + flags (`isJevEnabled`, `isJevShadow`) |
| `src/lib/bot-llm/classify-jev.ts` | Choice(intent) + Choice(pending) + Noul(×2) + `buildJevPending` |
| `src/lib/bot-llm/extract-bot-message.ts` | corre Jev en paralelo; shadow vs override |
| `src/lib/bot-llm/types.ts` | campos `jev_*` |
| `src/lib/bot/router.ts` | `RouterState.jevPending` + umbrales |
| `src/lib/bot-beta/unified-handler.ts` / webhook | wiring `pendingDomains` + `jevPending` |
| `src/app/(dashboard)/bot-beta/page.tsx` | panel debug Jev |

### Spike real (validado 19/09/2026)

- Endpoint `POST https://openrouter.ai/api/alpha/decisions` con `{ model, state, questions }`
  → `200` y `{ answers, usage }`. Shape confirmado (status 200, `typesafe/jev-1.13-20260917`).
- Costo real medido: ~$0.000018–0.000038 por llamada con 4 preguntas (~5 msgs/hora).
- Shadow en `/bot-beta` (Jev corre en paralelo, decide el LLM): coincidencia 4/4 en
  `llegó juan 8:30`, `pagué 18 mil de luz`, `Jo pago en efectivo`, `hola`.
- Modo activo (`JEV_SHADOW=false`): Jev sobrescribió el intent con `used=true` en los
  4 casos (confianza 0.84–1.0).
- Señal de pendientes (real): `"la 2"`→voucher 0.77; `"5000"`→expense 0.92;
  `"8:30"`→attendance 0.84; `"cuánto debo"` con voucher pendiente→`none` 0.14 (no roba).
- **Gate de confianza** (`JEV_OVERRIDE_MIN_CONFIDENCE = 0.6`): con un gasto pendiente,
  `"quiero 4 bastidores 60x40"` Jev devolvió `gasto` con 0.47 → NO se sobrescribe el
  LLM. Sin este gate, el caso se degradaba.

---

## 1) Qué es Jev y por qué encaja (y dónde no)

Jev es un *System One model*: no genera texto. Recibe `state` (string/objeto)
y un mapa de **preguntas tipadas**, y devuelve respuestas tipadas con
probabilidades calibradas:

| Pregunta | Devuelve | Uso en el bot |
|---|---|---|
| `choice` | opción + `probabilities` + `confidence` | clasificar `intent` (9 opciones) y dominio del pendiente |
| `noul` | probabilidad 0–1 de "sí" | ¿responde al pendiente? ¿lo reemplaza? |
| `score` | valor ponderado + legend | (no usado en esta fase) |

Todas las preguntas se evalúan en paralelo en una sola llamada: agregar
preguntas casi no cambia latencia ni costo. Por eso A+B van en **un solo request**.

**Encaja** en decisiones de conjunto cerrado: clasificar, rutear, gatear.
**No encaja** en:
- extracción de texto libre (nombres, proveedores): sigue el LLM;
- generación de respuesta rioplatense: sigue el LLM;
- audio/visión (voucher): sigue Gemini/Whisper.

---

## 2) Acceso y costo

- **OpenRouter** (misma `OPENROUTER_API_KEY`): `POST https://openrouter.ai/api/alpha/decisions`
  con `{ model, state, questions }` → `{ answers, usage }`.
  Modelos: `typesafe/jev-1.13` (pineado) o `~typesafe/jev-latest` (alias).
- Alternativas: Vercel AI Gateway (`typesafe-ai/jev`) o directo TypeSafe
  (`api.typesafe.ai/v1/systemone`, requiere early access).
- Precio: **$0.042 / M input tokens**, output gratis. $1 ≈ 23.8 M tokens ≈
  ~20.000–35.000 llamadas (≈800–1200 tokens/llamada con state + preguntas).
  10 días en dummy: **< $0.05**.

> Nota: el endpoint de OpenRouter usa la Decisions API, **no** `/chat/completions`.
> No es drop-in en `callOpenRouter`; se agrega `callJev` en `src/lib/ai/jev.ts`.

---

## 3) Flags (env global)

```
JEV_ENABLED=false          # master switch. false = comportamiento actual exacto
JEV_SHADOW=false           # true = corre Jev, loguea, pero usa el resultado del LLM
JEV_MODEL=typesafe/jev-1.13
JEV_TIMEOUT_MS=4000
```

Umbrales (constantes en código, ajustables): `answersPending >= 0.7`,
`supersedes >= 0.7` para ruteo de pendientes.

---

## 4) Diseño de archivos

```
src/lib/ai/jev.ts               # callJev() + flags + tipos. Nunca lanza hacia arriba.
src/lib/bot-llm/classify-jev.ts # Choice(intent) + Choice(pending_domain) + Noul(x2)
src/lib/bot-llm/extract-bot-message.ts  # corre Jev en paralelo; shadow o override
src/lib/bot-llm/types.ts        # campos jev_* en UnifiedExtraction
src/lib/bot/router.ts           # RouterState.jevPending opcional
src/lib/bot-beta/unified-handler.ts     # wiring pendingDomains + jevPending (dummy)
src/app/api/whatsapp/webhook/route.ts   # idem (gated por flag)
src/app/(dashboard)/bot-beta/page.tsx   # debug panel: intent/confidence de Jev
```

### Preguntas enviadas a Jev (una sola llamada)

`state`:
```json
{
  "message": "<texto entrante>",
  "contexto_pendiente": "<contextText de buildBotContextText>",
  "pendientes": ["expense", "voucher"],
  "fecha_hoy": "2026-09-19"
}
```

`questions`:
- `intent` → **choice** con las 9 opciones de `BotIntent` (criteria = definiciones del prompt actual).
- `pending_domain` → **choice** `{expense, attendance, voucher, voice, none}` ("¿a qué pendiente responde?").
- `answers_pending` → **noul** "¿El mensaje responde a la pregunta pendiente?".
- `supersedes` → **noul** "¿Es una orden nueva completa que reemplaza el pendiente?".

### Mapeo a `UnifiedExtraction`

Campos nuevos (opcionales, no rompen nada):
`jev_intent`, `jev_confidence`, `jev_probabilities`, `jev_pending_domain`,
`jev_answers_pending`, `jev_supersedes`, `jev_used`, `jev_error`, `jev_usage`.

- `JEV_SHADOW=true`: se guardan los `jev_*` como debug, `intent`/`confianza` siguen del LLM.
- `JEV_ENABLED=true` y `JEV_SHADOW=false`: `intent`/`confianza` salen de Jev; los campos
  abiertos siguen del LLM. `confianza` se deriva de `confidence` (≥0.75 alta, ≥0.45 media, si no baja).

---

## 5) Ruteo de pendientes (B)

`decideDispatch` recibe `jevPending` opcional (solo se pasa si `JEV_ENABLED && !JEV_SHADOW`):

```ts
jevPending?: {
  domain: 'expense'|'attendance'|'voucher'|'voice'|'none'
  answersPending: number
  supersedes: number
} | null
```

Lógica (antes de las ramas de pendientes actuales):
1. `supersedes >= 0.7` → ignora el pendiente y sigue el flujo normal (orden nueva gana).
2. `answersPending >= 0.7` y `domain != none` → despacha al dominio con
   `dispatchReason: 'pending_multiturn'`.
3. Si no, cae a las reglas actuales sin cambios.

Esto arregla ramas mudas conocidas:
- `webhook/route.ts` `case 'voucher'` que solo loguea;
- texto de voucher guardado como pendiente sin responder.

---

## 6) Protocolo de 10 días

Datos ya disponibles en `router_logs` (`intent`, `confianza`, `dudoso`,
`dispatched_to`, `dispatch_reason`, `extractor_source`, `debug_info.jev_*`).

| Día | Config | Medición |
|---|---|---|
| 1–2 | `JEV_SHADOW=true` | latencia real desde AR, % acuerdo Jev vs LLM, costo/1k msgs |
| 3–8 | `JEV_ENABLED=true`, shadow off | `dispatched_to: none/voucher`, `clarify_reask`, casos "no respondió" vs línea base |
| 9–10 | veredicto | si no mejora: `JEV_ENABLED=false`, cero deploy |

## 7) Rollback

`JEV_ENABLED=false` → pipeline actual al 100%. No se elimina ningún archivo ni ruta.

## 8) Spike / validación del payload (requiere key)

Con `OPENROUTER_API_KEY` seteada, confirmar el shape de `/alpha/decisions`:

```bash
node -e "fetch('https://openrouter.ai/api/alpha/decisions',{method:'POST',headers:{Authorization:'Bearer '+process.env.OPENROUTER_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({model:'typesafe/jev-1.13',state:'llegó juan a las 8:30',questions:{intent:{type:'choice',instructions:'¿Qué intención tiene el mensaje?',criteria:{asistencia_llegada:'llegada al trabajo',gasto:'gasto del negocio',otro:'otra cosa'}}}})}).then(r=>r.json()).then(d=>console.log(JSON.stringify(d,null,2)))"
```

## 9) Verificación

`npm run typecheck && npm run lint && npm test` + pruebas manuales contra
`/api/bot-beta/assistant` y `/api/bot-beta/unified` con: `llegó juan 8:30`,
`pagué 18 mil de luz`, `Jo pago en efectivo`, `la 2` (voucher pendiente),
`5000` (gasto pendiente), `hola`.
