# Plan de refactor: chatbot de pedidos (Bastidores GAL)

## Instrucción para quien lo implemente

Antes de escribir una sola línea: leer completo `main.py` (backend FacBal) y `chatbot.ts` (orquestador del bot). Entender qué existe hoy (funciones, endpoints, modelos de datos) antes de proponer una solución. No reescribir desde cero — extender y corregir lo que ya está, siguiendo la modularidad de este plan. Si algo de este plan choca con una restricción real del código (por ejemplo, un endpoint usado por otro cliente además del bot), avisar antes de tocarlo, no improvisar.

Al terminar cada módulo, entregar: qué archivo/función se tocó, qué se agregó, y un ejemplo concreto de input → output para poder validar contra los casos de prueba de la sección 6.

---

## 1. Qué NO tocar

Estas dos cosas funcionan bien hoy y no forman parte de este refactor:

- **Lectura de facturas pendientes** (`getFacturasPendientes`, intent `pending_invoices`).
- **Envío de lista de precios como imagen** (`getPriceListImages`, intent `price_list`, `sendImage`).

Si el refactor las toca de forma indirecta (por ejemplo, porque comparten el `order_context` o el `detectIntent`), verificar explícitamente que su comportamiento no cambió antes de dar por cerrado el trabajo.

---

## 2. Reglas de negocio a implementar correctamente

Esto es lo que el sistema tiene que calcular **sin usar el LLM** — son reglas determinísticas sobre la tabla `precios_referencia`.

### 2.1 Categorías y variantes

Categorías: `BASTIDOR`, `ACRILICOS`, `CIRCULARES`, `TAPACANTO`, `PINTURA` (embastar). Cada categoría tiene variantes propias (ej. bastidor: sin tela, lienzo profesional, lona preparada, doble 4cm). La categoría y variante se detectan por tokens en el texto del cliente. El precio depende de la combinación **categoría + medida + variante** — todo vive en `precios_referencia`.

**Revisar**: la detección de tokens hoy vive en `_detect_category_variant` y `_detect_variant_for_segment` (`main.py`). Confirmar que cubre todos los sinónimos reales que usan los clientes (revisar conversaciones históricas si hay logs) antes de darla por completa.

### 2.2 Redondeo de medidas no estándar

Regla exacta: para cada dimensión por separado, mirar el dígito de las unidades.
- Dígito de unidades **≥ 4** → redondear hacia arriba a la decena siguiente.
- Dígito de unidades **≤ 3** → redondear hacia abajo a la decena anterior.

Ejemplos dados:
- `81 x 94` → unidades de 81 es 1 (≤3, baja) → 80; unidades de 94 es 4 (≥4, sube) → 100. Resultado: **80 x 100**.
- `93 x 82` → unidades de 93 es 3 (≤3, baja) → 90; unidades de 82 es 2 (≤3, baja) → 80. Resultado: **90 x 80**.

**Importante — esto NO es lo que hace el código hoy.** `_find_best_perimeter_match` (línea ~810 de `main.py`) busca la referencia más cercana por perímetro/diferencia de dimensiones entre las medidas *que existen cargadas* en la tabla, no aplica esta regla de redondeo por dígito. Puede dar un resultado distinto al de la regla de negocio en casos donde la medida "redondeada correcta" no sea la más cercana por perímetro. Hay que reemplazar `_find_best_perimeter_match` por una función que aplique la regla de redondeo dígito por dígito como paso 1.

**Paso 2 — perímetro como fallback si la medida redondeada exacta no está en la tabla.** El redondeo por dígito da una medida "ideal" (ej. `81x94` → `80x100`), pero esa medida exacta puede no estar cargada en `precios_referencia` (no todas las combinaciones de medidas estándar tienen fila propia). En ese caso, buscar entre las medidas que sí están cargadas la que tenga el **mismo perímetro** que la medida redondeada, y usar su precio — no la más "cercana" en términos de diferencia de dimensiones, sino la de perímetro igual (o más cercano si no hay coincidencia exacta de perímetro tampoco).

Ejemplo: `42 x 141` → redondeo por dígito da `40 x 140` (perímetro = 360). Si `40x140` no está cargada en la tabla pero `80x100` sí (perímetro = 360 también), el precio es el de `80x100`, porque el perímetro es lo que determina el costo de material, no las dimensiones individuales.

Orden de resolución para cualquier medida no estándar:
1. Redondear cada dimensión por dígito (regla de arriba).
2. ¿La medida redondeada exacta existe en `precios_referencia` para esa categoría/variante? → usar ese precio.
3. Si no existe, buscar entre las filas cargadas la de perímetro igual (o más cercano) → usar ese precio.
4. Si ninguna de las dos existe, marcar como faltante (ver sección 3) — no inventar un precio.

Esto significa que `_find_best_perimeter_match` no se descarta del todo: se reordena para actuar *después* del redondeo por dígito y *solo* como fallback cuando la medida redondeada no tiene fila propia, en vez de ser el criterio principal como es hoy.

### 2.3 Servicio de pintura / embastado

Solo aplica a categoría `BASTIDOR`, nunca a `ACRILICOS` ni otras. Cálculo:
1. Redondear la medida pedida con la regla 2.2.
2. Buscar el precio del bastidor **sin tela** para esa medida redondeada.
3. Sumar 10%.

Ejemplo: pintura de `94 x 81` → redondea a `100 x 80` → bastidor sin tela `100x80` = $60.000 → precio pintura = $66.000.

**Revisar**: `_process_reglas` con `regla == 'pintura'` (línea ~943 de `main.py`) ya tiene esta lógica implementada, pero depende de que la medida "matches[0].medida" ya haya sido resuelta correctamente por el paso anterior — si el paso 2.2 está mal, esto hereda el error. Confirmar que sigue funcionando una vez corregido el redondeo.

### 2.4 Tapacanto

Mismo precio que bastidor variante "Lienzo Profesional" en esa medida. Ya implementado en `_process_reglas` con `regla == 'tapacanto'` — confirmar que sigue funcionando tras los cambios de 2.2, no reimplementar desde cero.

---

## 3. Cantidades (lo nuevo de esta ronda)

Cada ítem que el cliente menciona necesita cantidad, no solo medida/categoría/variante. Ver ejemplo real: *"quiero 5 bastidores de 60x40, 3 de 60x70 y uno de 90x10"* — hoy el sistema devuelve precios unitarios y pierde las cantidades y el ítem sin precio.

Requisitos:
- Extraer cantidad por cada segmento de dimensión (número en dígitos o en palabras: "uno", "dos", "tres"...). Default a 1 si no se menciona.
- Si una medida no tiene precio en la tabla (como `90x10` en el ejemplo), **no descartarla silenciosamente** — marcarla como pendiente/faltante y comunicarlo explícitamente al cliente, no solo omitirla del mensaje.
- El total del presupuesto es la suma de `cantidad × precio_unitario` de cada ítem, nunca la suma de precios unitarios sin multiplicar (el bug actual).

---

## 4. Flujo de pedido completo (etapas)

1. **Consulta**: el cliente pregunta por producto(s) — con o sin cantidad, con o sin medida exacta.
2. **Sugerencia de precio**: el sistema calcula precio por ítem (aplicando redondeo/reglas de 2.2–2.4) y arma un carrito con cantidad × precio = subtotal por ítem.
3. **Confirmación de productos**: se le confirma al cliente qué productos y cantidades entendió el sistema, antes de pasar a un total — para pescar errores de interpretación (ej. "confirmame: 5 bastidores 60x40, 3 de 60x70, ¿el de 90x10 lo cotiza un agente?").
4. **Confirmación de pedido**: una vez confirmados los productos, se presenta el presupuesto total y se pide la confirmación final ("confirmar pedido").
5. **Fuera de este alcance todavía**: orden de producción. No implementar en esta ronda, pero dejar el estado del pedido (`confirmado`) como el gancho natural para ese paso futuro.
6. **Handoff**: cualquier mensaje sobre fecha/hora de entrega, dirección, descuento, forma de pago, reclamos, o cualquier cosa que no sea catálogo/cantidad/confirmación → `[[HANDOFF]]`, sin que el bot intente resolverlo. Esto ya está parcialmente implementado vía el sentinel del LLM — confirmar que sigue disparando bien una vez que el flujo de confirmación de productos (paso 3, nuevo) esté en el medio.

---

## 5. Arquitectura modular pedida

Un módulo = una responsabilidad, testeable de forma aislada. No mezclar cálculo con redacción, ni extracción con persistencia.

| Módulo | Responsabilidad | Dónde vive hoy / dónde debería vivir |
|---|---|---|
| **`order-parser`** | De un texto libre → lista de `{cantidad, categoria, variante, medida}` por ítem. Sin acceso a DB. | Nuevo. Extiende `_extract_all_dims` + `_get_dim_position` + `_detect_variant_for_segment` de `main.py`, agregando extracción de cantidad. |
| **`pricing-engine`** | Dado un ítem parseado, resuelve precio: aplica redondeo (2.2), reglas de pintura/tapacanto (2.3/2.4), busca en `precios_referencia`. Devuelve precio o "faltante". Sin acceso a texto libre. | Refactor de `_process_single_dim_pair` + `_process_reglas` en `main.py`, separado de la extracción de texto. |
| **`cart-state`** | Carrito acumulado por conversación: items, cantidades, subtotales, total, estado (`cotizando` / `productos_confirmados` / `presupuesto_enviado` / `confirmado`). Lee/escribe `order_context` en Supabase. | Nuevo en `chatbot.ts`, reemplaza el uso actual de `order_context.ultima_consulta` (que asume un solo producto). |
| **`conversation-flow`** | Máquina de estados: qué hacer según `cart-state.status` + intent detectado (repreguntar, pedir confirmación de productos, pedir confirmación de pedido, avanzar a handoff). | Reemplaza el bloque `// ── ORDER FLOW ──` de `chatbot.ts`, hoy disperso en varios `if` seguidos. |
| **`llm-responder`** | Solo redacción en tono natural del carrito/presupuesto ya calculado. Nunca calcula, nunca decide de qué producto se habla. | Es el uso actual de `callOpenRouter` + `CHAT_SYSTEM_PROMPT`, pero con el prompt endurecido para que reciba números ya resueltos, no que interprete ambigüedad. |
| **`handoff-rules`** | Qué dispara derivación (sentinel del LLM + casos duros de código, como cantidad inválida). | Ya existe disperso en `chatbot.ts`; consolidar en un solo lugar para no tener criterios de handoff en dos sitios distintos. |

Cada módulo debería poder probarse con inputs de texto crudo (para `order-parser`) o carritos de ejemplo (para `pricing-engine` y `cart-state`) sin necesitar levantar el bot completo ni pegarle a OpenRouter.

---

## 6. Casos de prueba obligatorios antes de dar por cerrado el trabajo

Estos son ejemplos concretos, con el resultado esperado exacto:

1. `"bastidor sin tela 81x94"` → redondea a `80x100`, devuelve el precio de esa referencia (no el de la más cercana por perímetro si difiere).
2. `"bastidor sin tela 93x82"` → redondea a `90x80`.
2b. `"bastidor sin tela 42x141"` → redondea a `40x140` (perímetro 360). Si `40x140` no existe como fila en `precios_referencia` pero `80x100` sí (mismo perímetro 360), el precio devuelto es el de `80x100`. Confirmar que el sistema no descarta el pedido ni pide "medida no encontrada" en este caso, ya que sí hay match por perímetro.
3. `"embastame una pintura de 94x81"` → toma bastidor sin tela `100x80`, calcula precio + 10%. Confirmar que el mismo pedido en `ACRILICOS` (ej. `"acrilico 94x81"`) NO aplica esta regla.
4. `"tapacanto 60x40"` → mismo precio que bastidor Lienzo Profesional 60x40.
5. `"quiero 5 bastidores de 60x40, 3 de 60x70 y uno de 90x10"` → carrito con 3 ítems, cantidades 5/3/1 correctas, subtotales correctos, y el ítem `90x10` marcado explícitamente como sin precio (no omitido en silencio). Total del presupuesto = suma de subtotales de los ítems que sí tienen precio, con aviso de que falta confirmar el tercero.
6. Después del presupuesto: cliente dice `"dale, confirmo los de 60x40 y 60x70"` → pasa a estado `productos_confirmados`, se le presenta el total final, se pide `"confirmar pedido"`.
7. En cualquier punto del flujo, cliente pregunta `"¿me lo pueden traer el sábado?"` → handoff inmediato, sin intentar responder sobre logística.
8. Facturas pendientes y lista de precios (casos ya cubiertos) siguen funcionando exactamente igual que antes del refactor.