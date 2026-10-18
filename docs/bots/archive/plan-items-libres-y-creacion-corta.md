# Plan: ítems fuera de catálogo + creación en menos pasos

> **Estado:** implementado (Fases A y B). Ver notas de implementación al final.
> **Origen:** conversación real del 15/10/2026 (`conv 05fe8f78…`, `router_logs`
> id=435-439 + `bot_traces`) — "Palos de metal" (producto fuera de catálogo) y
> cantidad de pasos al crear.
> **Para:** el agente ejecutor. TS strict, seguir `src/lib/pedidos/`. Los
> incidentes de referencia están en `docs/bots/archive/notas-fallos-reales.md`.

## 1. Qué pasó (evidencia)

Pedido del usuario: **"haz un presupuesto para Jesus, 2 bastidores 40 x 89 y Palos
de metal a 0 pesos"**. Resultado real:

1. El bot pidió **glosario** por `"palos"`, `"metal"`, `"pesos"` (los trató como
   términos, no como un producto).
2. El usuario aclaró "no son términos, es un producto que no está en el catálogo,
   Palos de metal" → el bot preguntó algo raro (`¿Qué medida para "bastidor de
   bastidor"?`).
3. Luego cotizó **`1. 2× BASTIDOR 40 x 89 — $36.000`** y **`2. BASTIDOR 40 x 89 —
   $36.000`**: el **ítem libre se convirtió en un bastidor** (producto alucinado)
   y el precio pedido ("a 0 pesos") se ignoró. Total $108.000 (3 bastidores).

Causa (código):
- `classify-item.ts`: cualquier ítem sin categoría conocida cae a
  `DEFAULT_CATEGORIA = 'BASTIDOR'`. Un nombre de producto que no está en el
  catálogo no tiene otro lugar donde caer → se vuelve BASTIDOR.
- `comprehendOrder` (`understand.ts`) trata los términos desconocidos como
  candidatos a glosario, sin distinguir "palabra que modifica un producto" de
  "producto nuevo".
- `ParsedOrderItem` (`types.ts`) **no modela precio** (`{cantidad, texto}`): no hay
  forma de que "a 0 pesos" viaje con el ítem.
- `resolve-items.ts`: sin `AxB` intenta `resolveByAttr` (BASTIDOR devuelve null) →
  `pushFaltante`; al aparecer una medida después, lo resuelve **como bastidor**.

## 2. Decisiones

- **Ítem libre = línea manual.** Un producto que no está en el catálogo se cotiza
  como **línea manual** con el nombre que dio el usuario y **su precio** (puede ser
  `0`). `createInvoice` ya acepta descripción + precio arbitrarios → no hace falta
  tocar backend.
- Si el ítem libre **no trae precio** → se pregunta **ese** precio (una vez) y, si
  no contesta, queda "a cotizar a mano" (excluido del total, como hoy).
- **Nunca** convertir un ítem libre en bastidor por la aparición de una medida.
- **Creación corta:** UN mensaje pide cliente + envío/retiro (+ opcionales). Lo no
  dicho se **asume**: sin descuento, sin fecha, domicilio del padrón si es envío.
  **Obligatorio: envío o retiro** (y el cliente si no se sabe).

## 3. Fase A — Ítems fuera de catálogo (línea manual)

### A1. `types.ts`
- `ParsedOrderItem`: agregar `precio?: number | null`.
- `PedidoItem`: agregar `libre?: boolean` (línea manual, fuera de catálogo).

### A2. `parse-order.ts` (LLM, no calcula)
- Extraer **precio por ítem** cuando el usuario lo dice ("a 0 pesos", "$50000",
  "puesto 20mil"); devolverlo en `items[].precio`. NO derivar precios.
- Regla: un ítem sin medida, sin categoría conocida y con nombre propio
  ("palos de metal", "soporte X") es un **producto**, no un término.

### A3. `classify-item.ts` / `understand.ts`
- Distinguir tres casos por ítem:
  1. **Producto de catálogo** (categoría/regla/variante o `AxB`) → motor de precios.
  2. **Modificador desconocido** (palabra suelta que califica a otro producto, ej.
     "grosor 4", "moldura") → glosario (como hoy).
  3. **Ítem libre** (nombre propio no reconocido, sin ser modificador) → **no** es
     glosario y **no** asume BASTIDOR.
- `DEFAULT_CATEGORIA='BASTIDOR'` solo cuando el texto **tiene `AxB`** o una
  categoría/variante reconocida. Un nombre sin medida **no** es bastidor.
- Regla práctica para el caso 2 vs 3: si el ítem tiene **2+ palabras no
  reconocidas y ninguna medida** → ítem libre; si es **1 palabra** junto a un
  producto reconocido → término de glosario.

### A4. `resolve-items.ts`
- Nuevo resultado por ítem: **libre** (no `faltante` puro):
  - con `precio` del usuario → `{ libre:true, precio_unitario: precio, faltante:false }`
    (entra al total; `descripcion` = texto del usuario, capitalizado).
  - sin `precio` → `{ libre:true, faltante:true }` → "a cotizar a mano" nombrando
    el producto real (nunca "BASTIDOR").
- **Anti-alucinación**: al completar/corregir un ítem libre (`awaitingItemAttr` con
  `itemIndex`), la corrección se aplica a ESE ítem; no se re-clasifica como
  bastidor aunque llegue una medida.

### A5. `buildOrderSummary` (`summary.ts`)
- Mostrar libres como `Nombre — $X (manual)` o `Nombre — a cotizar a mano`. Nunca
  como bastidor.

### A6. Intérprete de cambios (`interpret-changes.ts`)
- Al targetear por nombre/medida, si **exactamente una** línea matchea la medida
  ("cambia el precio de 40 x 89"), resolverla; si hay 2+ → `unsupported` (como hoy).
  Esto es lo que dio "no sé a qué línea" por la línea fantasma.

## 4. Fase B — Creación en menos pasos

Hoy: cotizar → confirmar → `¿A nombre de quién?` → `askDatosCombinados`
(entrega+fecha+domicilio+descuento) → confirmar. Son 2-4 turnos tras la cotización.

### B1. Una sola pregunta combinada
- Reemplazar la secuencia `cliente → datos` por **UN** mensaje:
  > "Para cerrarlo decime: **¿a nombre de quién?** y **¿retira o es envío?**
  > (opcional: fecha, domicilio si es envío, descuento)."
- Se envía cuando falte cliente **o** entrega (lo demás es opcional).

### B2. Parser de la respuesta
- Extender `interpret-delivery.ts` (o un `interpret-order-brief`) para extraer de
  un solo mensaje: `cliente`, `tipo_entrega`, `fecha`, `domicilio`, `descuento`.
- Fallback determinístico: "a nombre de X" / "para X" → cliente; "retira"/"envío";
  "para el viernes"; "10%"/"$5000"; dirección como texto libre.

### B3. Defaults (asumir lo normal)
- `tipoEntrega` → **obligatorio** (si no se dijo, se pregunta solo eso).
- `fechaEntrega` → `''` (sin fecha) si no se dijo.
- `descuento` → `null` (sin descuento) si no se dijo.
- `clienteDomicilio` → si es envío: la dirección predeterminada del padrón
  (`getClientAddresses`); si no hay ninguna, preguntar **solo** el domicilio.

### B4. `allCollected` / `advance`
- Crear cuando estén: **cliente** + **tipoEntrega** (`fecha`/`descuento` ya
  resueltos por default). `advance` deja de bloquear por fecha/descuento.
- Máximo **un** turno de seguimiento (solo si falta entrega o cliente).

### B5. UX de confirmación
- El resumen final incluye los defaults aplicados ("Entrega: Retira · sin fecha ·
  sin descuento") para que el usuario vea qué se asumió y pueda corregir.

## 5. Tests de aceptación

1. "2 bastidores 40x89 y Palos de metal a 0 pesos" → línea libre **"Palos de metal
   — $0 (manual)"**, sin convertirla en bastidor, sin pedir glosario.
2. Mismo pedido sin precio en el ítem libre → pregunta **el precio del ítem libre**
   (no una medida de bastidor).
3. "Palos de metal" + luego "el bastidor es de 40x89" → el bastidor toma la medida;
   el ítem libre **no** cambia.
4. Creación: "haz un presupuesto para Jesus 2 bastidores 40x89 retira" → crea en
   **un solo turno** con `tipo_entrega='Retira'`, `fecha_entrega=''`, sin descuento.
5. Falta entrega → un único follow-up: "¿retira o envío?".
6. "cambia el precio de 40 x 89 a 20mil" con 1 sola línea que matchea → aplica.

## 6. Fuera de alcance

- No tocar el motor de precios (`src/lib/precios/`).
- No agregar productos al catálogo desde el bot (eso es backend/galv2).
- No cambiar el pipeline de voucher ni el gastos/asistencia.

## 7. Referencias

- Flujo: `src/lib/pedidos/{parse-order,understand,classify-item,resolve-items,catalog-attrs,summary,interpret-delivery,execute}.ts`.
- Evidencia: `router_logs` id=435-439, `bot_traces` (conv `05fe8f78…`, 2026-10-15 23:48-23:53).
- Relacionado: `docs/bots/archive/plan-presupuestos-por-bot.md`, `docs/bots/plans/plan-orquestador-llm-bots-rigidos.md`.

## Notas de implementación (2026-10-15)

- **A1/A2:** `ParsedOrderItem.precio`; `parse-order` extrae `precio` por ítem (LLM).
- **A3/A4:** `resolve-items` marca **libre** cuando la categoría es BASTIDOR por
  default, sin regla, y hay 2+ términos desconocidos (o 1 con precio del usuario);
  `comprehendOrder` saltea los `libre` (no piden glosario ni medida).
- **A5:** `summary` muestra la línea manual con `(manual)`.
- **B1/B2:** `askDatosCombinados` incluye el cliente cuando falta; `interpret-delivery`
  extrae `cliente`; `handleDatosAnswer` captura el nombre (con guarda de teléfono).
- **B3/B4:** `advance` asume `fechaEntrega=''` y `descuento=null` si no se dijeron;
  ya no pregunta fecha/descuento por separado. Obligatorio: cliente + entrega.
- **Intérprete de cambios (refinamiento):** `interpret-changes` ahora resuelve la
  línea por **número, medida o nombre** (`ChangeTarget`), no solo por número; si la
  referencia es **ambigua** pide cuál; y permite **fijar el precio de un ítem "a
  cotizar a mano"** (pasa a entrar en el total). `intent.ts` suma el verbo "haz".
