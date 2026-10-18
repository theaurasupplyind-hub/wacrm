# Catálogo de acciones: operar el programa por chat

> Usuarios: **los dueños/jefes**, no clientes. El bot es el UX conversacional del
> programa (`galv2-tauri` + `backend_gal`).
> Fuente: inventario 15/10/2026 — `galv2-tauri/src`, `backend_gal/main.py`,
> `src/lib/bot-assistant/tool-registry.ts`.
> ⚠️ Es un **inventario de roadmap**, no el listado de lo implementado: la
> fuente de verdad de las tools es `src/lib/bot-assistant/tool-registry.ts`.

Convenciones:

- **Estado bot**: ✅ tool/experiencia existente · 🟡 parcial (existe flujo pero no tool) · ❌ gap (el programa lo hace, el bot no).
- **R/W**: lectura (libre) o escritura (gate + confirmación + undo 24h).
- **Esfuerzo**: S (<1 día) · M (2-3 días) · L (semana, incluye migración/tabla nueva).

---

## 1. Tareas y pendientes

| # | Acción (ejemplo de chat) | R/W | Endpoint | Estado bot | Esfuerzo |
|---|---|---|---|---|---|
| 1.1 | *"Anotá: llamar al proveedor de madera"* — crear tarea | W | `POST /tasks` | ❌ | S |
| 1.2 | *"Tachá la tarea de llamar al proveedor"* — completar | W | `PUT /tasks/{tid}` | ❌ | S |
| 1.3 | *"¿Qué tengo pendiente?"* — listar abiertas | R | `GET /tasks` | ❌ | S |
| 1.4 | *"Borrá / recuperá esa tarea"* | W | `DELETE /tasks/{tid}`, `POST /tasks/{tid}/restore` | ❌ | S |

Modelo: `{id, text, done, position, pinned, assigned_by, images[], reply_count}`.
El alta/baja es trivial; el valor está en 1.3 (el jefe pregunta, no abre el panel).

## 2. Kanban de facturas / proceso

Columnas: `PEDIDO → EN_PROCESO → LISTO → ENTREGADO` (+ `EN_ESPERA`, `ARCHIVADO`).

| # | Acción (ejemplo de chat) | R/W | Endpoint | Estado bot | Esfuerzo |
|---|---|---|---|---|---|
| 2.1 | *"Pasá la F-10231 a LISTO"* — mover factura | W | `PATCH /invoices/{fid} {estado_kanban}` | ❌ | S |
| 2.2 | *"¿Qué hay en proceso / listo / para entregar?"* — ver columna | R | `GET /invoices?estado_kanban=` | ❌ | S |
| 2.3 | *"¿Qué vence esta semana?"* — vencidos por `fecha_entrega` | R | `GET /invoices` + filtro fecha | ❌ | S |
| 2.4 | *"Resumen del kanban"* — conteo por columna | R | `GET /invoices/resumen` | ❌ | S |

Mover a ENTREGADO además setea entrega y limpia estados de taller (lo hace el backend).
No existe entidad de recordatorios: 2.3 se emula con filtro (tabla real = M/L, fuera de alcance).

## 3. Actividad reciente

| # | Acción (ejemplo de chat) | R/W | Endpoint | Estado bot | Esfuerzo |
|---|---|---|---|---|---|
| 3.1 | *"¿Qué se hizo hoy?"* — pagos + facturas del día | R | `GET /payments` + `GET /invoices` (composición, no hay `/actividad`) | ❌ | S |
| 3.2 | *"Últimos movimientos de la semana"* | R | ídem con rango | ❌ | S |

Hoy es agregación del frontend (`PanelControl.svelte`); el bot replica la unión.

## 4. Clientes: ficha, direcciones, saldos

| # | Acción (ejemplo de chat) | R/W | Endpoint | Estado bot | Esfuerzo |
|---|---|---|---|---|---|
| 4.1 | *"Dame la ficha de Puerto Maderas"* — datos + direcciones + saldo | R | `GET /clients/{cid}` + `GET .../addresses` + facturas−pagos | 🟡 (saldo existe como `consultar_facturas`; ficha completa no) | S |
| 4.2 | *"Cambiále la dirección a X"* — modificar dirección | W | `PUT /clients/{cid}/addresses/{aid}` | ❌ | S |
| 4.3 | *"Agregale la dirección del taller"* — alta dirección / default | W | `POST .../addresses`, `PUT .../default` | ❌ | S |
| 4.4 | *"Da de alta al cliente Y"* | W | `POST /clients` | ❌ (solo implícito en flujo pedidos) | S |
| 4.5 | *"Fusioná estos dos clientes duplicados"* | W | merge en `client.ts` (sin endpoint dedicado) | ❌ | M |

## 5. Cobros y comprobantes

| # | Acción (ejemplo de chat) | R/W | Endpoint | Estado bot | Esfuerzo |
|---|---|---|---|---|---|
| 5.1 | *"Registrá que Aldo pagó 39mil de la F-10695"* — registrar cobro | W | `POST /payments` (`registrarPago`) | ❌ (excluido a propósito; habilitar con gate) | S |
| 5.2 | *"¿Qué comprobantes hay para revisar?"* | R | `GET /voucher-reviews` | ❌ (pipeline solo en bot-beta) | S |
| 5.3 | *"Anulá / corregí ese cobro"* | W | `DELETE/PUT /payments/{pid}` | 🟡 (solo vía deshacer 24h) | S |

## 6. Gastos y proveedores

| # | Acción (ejemplo de chat) | R/W | Endpoint | Estado bot | Esfuerzo |
|---|---|---|---|---|---|
| 6.1 | *"Gasté 5000 en luz"* — registrar gasto | W | `createExpense` | ✅ `registrar_gasto` | — |
| 6.2 | *"Le debemos 3M a Puerto Maderas"* — consultar deuda proveedor | R | `searchProviders` (balance) | ✅ `buscar_proveedores` | — |
| 6.3 | *"Pagale 900mil a Puerto Maderas"* — pago a proveedor | W | `POST /providers/movements` (PAYMENT) | ❌ | S |
| 6.4 | *"Cargale una compra de 200mil"* — compra/stock proveedor | W | `POST /providers/movements` (PURCHASE/STOCK_IN) | ❌ | S |
| 6.5 | *"Gastos de hoy / de la semana"* | R | `listExpenses` | ✅ `listar_gastos` | — |
| 6.6 | *"Creá la categoría Viandas"* | W | `POST /expense-categories` | ❌ | S |

## 7. Empleados, sueldos y asistencia

| # | Acción (ejemplo de chat) | R/W | Endpoint | Estado bot | Esfuerzo |
|---|---|---|---|---|---|
| 7.1 | *"Llegó Jesus 8:30"* — asistencia | W | `POST /attendance` | ✅ `registrar_asistencia` | — |
| 7.2 | *"Pagale 50mil de adelanto a Jesus"* — pago/adelanto | W | `POST /employees/payments` | ❌ | S |
| 7.3 | *"Ficha de Jesus"* — datos + sueldo + asistencia | R | `GET /employees/{eid}` + pagos + asistencia | ❌ | S |
| 7.4 | *"¿Quién faltó hoy / esta semana?"* | R | `GET /attendance` + empleados | 🟡 (asistencia individual sí, barrido no) | S |
| 7.5 | *"Da de alta / baja a …"* | W | `POST/DELETE /employees` | ❌ | S |

## 8. Presupuestos y ventas

| # | Acción (ejemplo de chat) | R/W | Endpoint | Estado bot | Esfuerzo |
|---|---|---|---|---|---|
| 8.1 | *"2 bastidores 60x40 sin tela"* — cotizar | R | motor local + `/products/*` | ✅ flujo WhatsApp + `cotizar_pedido` | — |
| 8.2 | *"A la pintura 135x190 descuentale 10%"* — modificar línea | R | en memoria (nada creado) | ✅ `interpret-modification` | — |
| 8.3 | *"Creá el presupuesto"* — crear documento | W | `executePedido` / `POST /invoices` | 🟡 (flujo WhatsApp sí; como tool no) | S/M |
| 8.4 | *"¿Qué tiene el P-123?"* — ver detalle | R | `GET /invoices/{fid}` (`getInvoice`) | ❌ | S |
| 8.5 | *"Anulá la factura 123 / restaurala"* | W | `DELETE /invoices/{fid}`, `POST /invoices/{fid}/restore` | 🟡 (solo vía deshacer) | S |

## 9. Caja y reportes

| # | Acción (ejemplo de chat) | R/W | Endpoint | Estado bot | Esfuerzo |
|---|---|---|---|---|---|
| 9.1 | *"¿Cómo va la caja hoy?"* — cobros − pagos − sueldos | R | unión `payments` + `expenses` + sueldos (sin `/caja`) | ❌ | S |
| 9.2 | *"Resumen de la semana"* — ficha semanal + top deudores + KPIs | R | `/invoices` + `/resumen` + `/payments` (+ `/analisis/semanal`) | ❌ | S |
| 9.3 | *"Gastos por categoría este mes"* | R | `GET /expenses/summary?group_by=` | ❌ | S |

9.1 y 9.2 hoy se calculan en el frontend (`Caja.svelte`, `FichaSemanal.svelte`); el bot replica las llamadas. Un `GET /caja` consolidado sería M (backend).

## 10. Precios y catálogo

| # | Acción (ejemplo de chat) | R/W | Endpoint | Estado bot | Esfuerzo |
|---|---|---|---|---|---|
| 10.1 | *"¿Precio del bastidor 40x50?"* — precio directo | R | `/products/search`, `/products/suggest-price` | ❌ (`buscar_productos` no trae precio) | S/M |
| 10.2 | *"Pasame la lista de precios"* | R | `GET /price-list-images` | ❌ | S |
| 10.3 | *"Cambiá el precio de X"* — CRUD producto/regla | W | `PUT /products/{pid}`, `/pricing-rules` | ❌ | M |

## 11. Productos y stock

| # | Acción (ejemplo de chat) | R/W | Endpoint | Estado bot | Esfuerzo |
|---|---|---|---|---|---|
| 11.1 | *"¿Hay stock de lona?"* | R | `GET /products/search` (campo `stock`) | 🟡 (sin tool dedicada) | S |
| 11.2 | *"Cargá el producto X / corregí el precio"* | W | `POST/PUT /products` | ❌ | S |

## 12. Notas y conocimiento

| # | Acción (ejemplo de chat) | R/W | Endpoint | Estado bot | Esfuerzo |
|---|---|---|---|---|---|
| 12.1 | *"Anotá: el proveedor atiende de 8 a 12"* | W | `GET/POST/DELETE /notes` | ❌ | S |
| 12.2 | *"¿Qué significa 'moldura'?"* — glosario de taller | R/W | `order_glossary` (supabase) | ✅ flujo pedidos | — |

---

## Orden de construcción propuesto

- **Tanda 1** — seguimiento diario del jefe: kanban (2.1, 2.2, 2.4) + tareas (1.1–1.3).
- **Tanda 2** — reemplazar abrir el programa para mirar: ficha cliente (4.1), direcciones (4.2–4.3), actividad hoy (3.1), caja hoy (9.1).
- **Tanda 3** — escrituras con gate + undo: cobros (5.1), pagos proveedor/empleado (6.3, 7.2), crear presupuesto como tool (8.3), anular/restaurar (8.5).
- **Tanda 4** — reportes: ficha semanal (9.2), vencidos (2.3), gastos por categoría (9.3), precios (10.1–10.2).

Notas:

- Deuda **por teléfono** (identificar al que escribe): descartado, los que operan son los jefes.
- Todo lo marcado S usa endpoints existentes; solo compone llamadas (2-3 GET) o expone un POST con el effect-gate ya construido.
- Fuera de alcance por ahora: tabla de recordatorios con push, cierre/arqueo de caja, merge de clientes (M), edición de precios (M).
