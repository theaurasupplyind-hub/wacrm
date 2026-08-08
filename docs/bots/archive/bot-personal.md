# [ARCHIVO] Plan: Bot personal multiuso

> **Estado:** ⏳ Planificado — **no iniciado**. Documenta la visión de unificar
> todos los intents del bot en un asistente con router por umbral de confianza.
> **Qué lo reemplaza:** por ahora cada sistema funciona por separado
> (ver [`architecture.md`](../architecture.md)); el roadmap general está en
> [`architecture.md`](../architecture.md) §11.
>
> Se conserva como registro del plan de largo plazo. Referencias de código
> actualizadas a las rutas vigentes.

---

# Plan: Bot personal multiuso (voice orders + gastos + asistencia + vouchers + facturas)

> **Estado:** Planificado
> **Alcance:** Bot de WhatsApp personal para un solo usuario (el dueño). Multiuso: pedidos, pagos, gastos, asistencia y consultas. A futuro se separará el bot de pedidos.
> **Contexto técnico:** [`architecture.md`](../architecture.md) · [`voice-orders.md`](../voice-orders.md) · [`vouchers.md`](../vouchers.md)

---

## Objetivo

Convertir el bot actual (que hoy solo resuelve pedidos, gastos, asistencia y vouchers por separado con reglas binarias) en un asistente unificado que:

1. **Rutee bien** los 6 intents (`pedido`, `gasto`, `voucher`, `asistencia`, `factura`, `otro`) sin que se pisen entre sí.
2. **Entienda ambigüedad** con búsqueda semántica (RAG + embeddings) en lugar de string matching disfrazado.
3. **Falle de forma inteligente** con un umbral de confianza de 3 niveles (resuelve / pregunta / escala), no binario.
4. **Escale a humano** de forma explícita y revisable, en lugar de responder un error seco.
5. **Mejore con datos**: loop de logs que alimenta sinónimos y ejemplos few-shot.

---

## Diagnóstico del estado actual

### Enrutado hoy (`src/app/api/whatsapp/webhook/route.ts:1258-1350`)

```
classifyIntent() (LLM) → {tipo, confianza}
  ├── confianza == "alta"  → dispatch primario:
  │     gasto      → processExpenseMessage
  │     asistencia → processAttendanceMessage
  │     pedido | factura → processTextOrder (voice orders)
  │     (voucher NO tiene dispatch primario por texto)
  └── confianza == "baja" / "otro" / falló → fallback por regex:
        looksLikeExpense     → expense
        looksLikeAttendance  → attendance
        si no                → voice order
```

### Tabla de escenarios — cobertura actual

| # | Escenario | Ejemplo | Hoy | Problema |
|---|-----------|---------|-----|----------|
| 1 | Pedido por voz/texto con producto claro | "3 bastidores 60x40 sin tela" | ✅ Voice orders | — |
| 2 | Pedido con producto ambiguo / sinónimo | "el marco ese chico con tela" | ❌ | `suggestPrice` es string match; falla sin términos exactos |
| 3 | Respuesta de variante | "lienzo profesional" | ✅ Voice orders (multi-turn `voice_context`) | — |
| 4 | Confirmación / cancelación de presupuesto | "dale mandalo" | ✅ Voice orders | — |
| 5 | Consulta de deudas / saldos | "cuánto debe el cliente X?" | ❌ | `factura` se manda a `processTextOrder` → se parsea como pedido |
| 6 | Aviso de pago por imagen/PDF | comprobante adjunto | ✅ Voucher (matching de fases + stage a revisión) | — |
| 7 | Aviso de pago por texto | "transferí para la factura 001" | ❌ | No hay dispatch primario de voucher por texto; el fallback regex lo manda a **gastos** ("transferí" está en `EXPENSE_INTENT_KEYWORDS`, `parse-expense.ts:11`) |
| 8 | Registro de gasto | "pagué 18 mil de luz" | ✅ Expense | — |
| 9 | Gasto con categoría/proveedor ambiguo | — | ⚠️ | Fuzzy match por regex/tokens; pregunta 1 campo a la vez |
| 10 | Asistencia | "llegó Juan" / "Juan de licencia" | ✅ Attendance | Match por tokens; sin semántica |
| 11 | Saludo / cháchara | "hola", "gracias" | ❌ | `otro` cae al fallback genérico → termina en voice order |
| 12 | Contextos multi-turno en conflicto | gasto pendiente + voucher pendiente | ⚠️ | 3 contextos separados (`voice_context`, expense context, `voucher_context`) compitiendo; `shouldSuppressVoiceOrder` es un parche |

### Cómo escala a humano HOY

| Sistema | Mecanismo | ¿Escala? |
|---------|-----------|----------|
| Voucher | Si no hay match → "Un agente lo revisará" + **stage en `createVoucherReview`** para panel FacGal | ✅ Maduro |
| Voice orders | Solo error "No se reconoció ningún producto" | ❌ |
| Expense | Pregunta; si falla, error genérico | ❌ |
| Asistencia | Error "No encontré ningún empleado" | ❌ |
| Chatbot (deshabilitado) | `[[HANDOFF]]` sentinel + `status: pending` + `ai_autoreply_disabled` | ✅ (no usado) |

---

## Lo que el approach RAG propuesto NO cubre (y qué haremos)

1. **Bugs de routing** (ningún RAG los resuelve): `factura`→voice, `voucher` texto→gastos, `otro`→voice. → **Fase 1 (router)**.
2. **RAG del catálogo solo aplica a pedidos.** Gastos/asistencia buscan categorías/proveedores/empleados → **Fase 5 (índices de entidades)**.
3. **Fallback binario actual** → necesita umbral de confianza de 3 niveles → **Fase 2**.
4. **Escalación a humano inexistente** fuera de vouchers → **Fase 2 (tabla `bot_escalations` + panel)**.

---

## Fases

### Fase 1 — Router unificado + modelo de intención estructurada

**Objetivo:** un solo pipeline de interpretación que rute bien los 6 intents y resuelva los bugs de routing. Sin RAG todavía.

**Archivo nuevo:** `src/lib/bot/intent-schema.ts`

```ts
export interface BotIntent {
  tipo: 'pedido' | 'gasto' | 'voucher' | 'asistencia' | 'factura' | 'otro'
  confianza: 'alta' | 'baja'
  necesita_humano: boolean              // escalación explícita (patrón RasaGPT)
  entidades: {
    monto?: number
    fecha?: string
    categoria?: string
    empleado?: string
    proveedor?: string
    cliente?: string
    items?: { descripcion: string; cantidad: number }[]
    variante?: string
  }
}
```

**Archivo nuevo:** `src/lib/bot/router.ts`

- Decisor único que reemplaza el bloque `route.ts:1258-1350`.
- Reglas:
  - `confianza alta` + `necesita_humano=false` → handler del tipo.
  - `confianza baja` → intentar regex/contexto del tipo; si hay ambigüedad real → escalar.
  - `otro` → NO tocar voice order; responder saludo/ayuda o escalar.
  - `factura` → handler de consulta de saldos.
  - `voucher` en texto → prioridad sobre `gasto` (ambos usan "transferí/pagué").
- Absorbe y elimina `shouldSuppressVoiceOrder` (`src/lib/bot-coordination.ts`).

**Archivos a modificar:**

| Archivo | Cambio |
|---------|--------|
| `src/app/api/whatsapp/webhook/route.ts` | Swap del bloque de dispatch por `router.ts` |
| `src/lib/ai/intent-classifier.ts` | Alinear prompt al nuevo schema (hoy solo devuelve `tipo/confianza`, no entidades) |
| `src/lib/bot-coordination.ts` | Eliminar (se absorbe en el router) |

**Handler nuevo:** `src/lib/facturas/` — consulta programática de deudas/saldos vía `getFacturasPendientes()` + respuesta en lenguaje natural con datos reales (patrón "intención → query → respuesta real", evita alucinación). La **creación** de facturas ya funciona vía voice orders; este handler solo consulta saldos.

**Migración nueva:** `supabase/migrations/043_bot_escalations.sql`

```sql
CREATE TABLE IF NOT EXISTS bot_escalations (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  contact_id      uuid NOT NULL REFERENCES contacts(id),
  intent          text NOT NULL,
  message_text    text NOT NULL,
  entidades       jsonb,
  razon           text NOT NULL CHECK (razon IN ('baja_confianza', 'sin_match', 'ambiguedad')),
  candidatos      jsonb,
  estado          text NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'resuelto', 'descartado')),
  resolucion      jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
```

> **Nota:** la migración `043` ya está ocupada por `043_voucher_atomic_pending.sql`.
> Si se implementa este plan, usar el siguiente número libre.

---

### Fase 2 — Fallback inteligente por umbral + escalación a panel

**Objetivo:** reemplazar el fallback binario por la lógica de desambiguación del approach.

**En `router.ts` + cada handler:**

- **Nivel 1 — claro:** `confianza alta` y el handler resuelve con datos reales → responde.
- **Nivel 2 — ambigüedad:** 2-3 candidatos posibles → pregunta para desambiguar ("¿te referís a X o Y?"). Los datos ya existen: `variantes_disponibles` en voice, `candidatePool` en voucher, `sugerencias` en FacBal.
- **Nivel 3 — escala:** `confianza baja`, sin candidatos, o error → inserta en `bot_escalations` y responde "no pude resolverlo, queda en revisión para el dueño".

**Deuda técnica pagada acá:** unificar los 3 contextos multi-turno (`voice_context`, expense context, `voucher_context`) en una sola columna `bot_context` (jsonb) en `conversations`, para que el router sepa siempre "qué estoy esperando del usuario" y no mande el mensaje a dos handlers a la vez.

**Panel de revisión:** ruta nueva `/bot-escalations` (vista simple en wacrm) para listar `estado = 'pendiente'`, ver el texto original + entidades interpretadas, y marcarlas `resuelto`/`descartado` con una nota. (A confirmar: ¿panel en wacrm o en galv2-tauri como los vouchers? Ver decisiones pendientes.)

---

### Fase 3 — RAG del catálogo de productos (pedidos)

**Objetivo:** que `resolveItems()` entienda expresiones ambiguas aunque el usuario no use los términos exactos del catálogo.

**Pasos:**

1. **Index** — job/script que baja el catálogo desde FacBal y genera embeddings por producto: `nombre + categoría + medida + variante + sinónimos`. Tabla `ai_catalog_embeddings` (producto_id, embedding `vector(1536)`) + RPC `match_ai_catalog_semantic` (copia el patrón de la migración 030: HNSW + `<=>` coseno).
2. **Retrieval** — en `resolveItems()`, antes de `suggestPrice`, embed la descripción del item → top-k semántico → usar los candidatos para llamar `suggestPrice`/`bulkPrice` con términos **resueltos**.
3. **Sinónimos** — los sinónimos agregados tras revisar fallos (Fase 4) alimentan el texto de embedding.
4. **Umbrales** — top-1 muy cercano → resolver; 2-3 cercanos → desambiguar; nada → escalar.

**Reutiliza:** `src/lib/ai/embeddings.ts` (ya lista) + infra pgvector de la migración 030.

---

### Fase 4 — Loop de mejora con logs reales

**Objetivo:** iterar con datos, no a ojo.

- `bot_escalations` guarda qué falló, el texto original y las entidades interpretadas.
- Panel permite al dueño marcar `resuelto` y escribir la corrección ("era acrílico 50x70"). Eso alimenta:
  - los **sinónimos** del embedding (Fase 3),
  - los **ejemplos few-shot** de `parse-order.ts` y `intent-classifier.ts`.
- Métrica simple por intent: % resuelto sin escalar por tipo. Revisión mensual.

---

### Fase 5 — RAG de entidades (gastos y asistencia) — post-lanzamiento

- Índice de **empleados** (asistencia: "llegó Juanca" → Juan Carlos) y de **categorías/proveedores de gasto** (reemplaza `fuzzy-match.ts` por búsqueda semántica).
- Reutiliza todo lo de Fase 3 (embedding + RPC + umbrales); solo cambia la fuente del índice.

---

## Orden de despliegue y verificación

| Fase | Entregable | Desplegable por separado | Verificación |
|------|-----------|--------------------------|--------------|
| 1 | Router unificado + escalaciones + handler de facturas | ✅ | Routing correcto de los 6 intents; sin cambios en resolución de productos |
| 2 | Umbral 3 niveles + contexto unificado + panel | ✅ | Pedidos ambiguos preguntan/escalan en vez de romper |
| 3 | RAG catálogo | ✅ | Mejora resolución de pedidos ambiguos |
| 4 | Loop de mejora | Continuo | Data de las fases 1-3 alimenta sinónimos y few-shots |
| 5 | RAG entidades | ✅ | Se decide con logs del campo real |

**Nota de seguridad:** todo el pipeline mantiene `commit=false` por defecto (preview sin crear factura), preservando el flujo actual de copia-pega del dueño.

---

## Decisiones pendientes

1. **Indexado del catálogo**: ¿se baja de `GET /products/search` con paginación, o existe un endpoint de listado completo en FacBal API? Define cómo sync/indexar sin golpear la API por cada pedido.
2. **Panel de escalaciones**: ¿en wacrm (ruta `/bot-escalations`) o en galv2-tauri (como los vouchers hoy)?
3. **`factura` (consultar deudas)**: confirmar si se quiere handler de consulta de saldos, o si el dueño revisa saldos en FacGal y el bot solo debe escalar ese intent.

---

## Referencias de código clave

| Archivo | Rol |
|---------|-----|
| `src/app/api/whatsapp/webhook/route.ts` | Webhook + bloque de dispatch (líneas 1258-1350) |
| `src/lib/ai/intent-classifier.ts` | Clasificador LLM actual (`tipo`/`confianza`) |
| `src/lib/voice-orders/parse-order.ts` | Parseo LLM de pedidos (prompt few-shot) |
| `src/lib/voice-orders/execute-order.ts` | `resolveItems()` → `suggestPrice` (string match) |
| `src/lib/facbal/client.ts` | Cliente FacBal (`suggestPrice`, `bulkPrice`, `getFacturasPendientes`, `buscarProductos`, `listProviders`, `listEmployees`) |
| `src/lib/expenses/parse-expense.ts` | Parser regex de gastos (`EXPENSE_INTENT_KEYWORDS`) |
| `src/lib/expenses/fuzzy-match.ts` | Match regex/tokens de categorías/proveedores/empleados |
| `src/lib/attendance/parse-attendance.ts` | Parser regex de asistencia |
| `src/lib/ai/voucher-pipeline.ts` | Pipeline de voucher + stage a revisión |
| `src/lib/ai/embeddings.ts` | Embeddings (`text-embedding-3-small`, 1536 dims) |
| `supabase/migrations/030_ai_knowledge.sql` | Infra pgvector (HNSW + RPC `match_ai_knowledge_semantic`) |
| `supabase/migrations/031_voucher_extractions.sql` | Modelo de referencia para `bot_escalations` |
