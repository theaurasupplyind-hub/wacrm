# Gaps del bot de gastos

Estado: análisis. Alcance de soluciones detalladas: gaps 1-6. Gaps 7-8 documentados como futuros.

## Contexto e integración

- wacrm orquesta el webhook de WhatsApp: extracción LLM unificada (`src/lib/bot-llm/`) + router de intents (`src/app/api/whatsapp/webhook/route.ts:1532-1600`).
- Los gastos se persisten en `backend_gal` (`POST /expenses`, `backend_gal/main.py:3966`). Ese endpoint además crea los movimientos legacy que la app de escritorio consume: `movimientos_proveedor` y `pagos_empleados` (`backend_gal/main.py:3990-4043`).
- galv2-tauri comparte ese backend. Lee `expenses`/`movimientos_proveedor`/`pagos_empleados` y escribe movimientos legacy directamente. **No consume el LLM ni el router del bot** (su "Gasto Rápido" reimplementa el parseo con regex local en `src/lib/utils/quickExpense.ts`).

## Operaciones cubiertas hoy

- `gasto` (un gasto) y `multi_expense` (varios gastos en un mensaje).
- Proveedor por fuzzy-match → categoría default "Pago a proveedor" → movimiento `PAYMENT` (reduce deuda).
- Empleado → categoría "Sueldos y salarios" → `EmployeePayment`.
- Deuda: solo si el texto trae "debemos/adeudamos/deuda" → "Compra a proveedor" → `PURCHASE` (aumenta deuda).
- Saldo pendiente detectado por regex → segundo gasto "Saldo pendiente de X".
- Entrada por texto, audio (Whisper + regex) e imagen/PDF (Gemini multimodal).
- Multi-turn para monto y categoría; confirmación interactiva solo si es ambiguo.

## Gaps

### G1. Compras a proveedores mal interpretadas

**Evidencia:**
- El esquema del LLM no tiene intent ni campo de compra/deuda (`src/lib/bot-llm/extract-bot-message.ts:6-140`).
- La deuda solo se dispara por keywords "debemos/adeudamos/deuda" (`src/lib/expenses/fuzzy-match.ts:222-225`).
- La regla del prompt "compré N [producto catálogo] → pedido, NUNCA gasto" desvía compras de catálogo a voice (`extract-bot-message.ts:50`).
- PAYMENT/PURCHASE se decide por el slug de la categoría en el backend (`backend_gal/main.py:3995`).

**Efecto:** "compré mercadería a [proveedor] por 5000" no genera deuda: cae en "Pago a proveedor" → movimiento `PAYMENT` que reduce una deuda inexistente. "Compré 10 bastidores a [proveedor]" se va a `pedido` (voice), nunca a gasto.

**Propuesta:**
- Añadir `tipo_gasto: "compra" | "pago" | "gasto" | null` y `saldo_pendiente: number | null` al esquema de extracción LLM (y a `multipleExpenses`).
- `fuzzy-match.ts` prioriza `tipo_gasto` para inferir "Compra a proveedor" vs "Pago a proveedor"; keywords quedan como fallback.
- `execute-expense.ts` envía `mov_type` explícito (PURCHASE/PAYMENT) al backend.

### G2. Gastos operativos a proveedor inflan deuda por error

**Evidencia:** `backend_gal/main.py:3995` — toda categoría con `provider_id` cuyo slug no sea `pago-a-proveedor` genera `PURCHASE`.

**Efecto:** "gasté 3000 de peaje a transporte X" → crea categoría "peaje" → genera una deuda a transporte X.

**Propuesta:**
- Añadir `mov_type` opcional en `ExpenseCreate` de `backend_gal`; el bot lo envía cuando sabe el tipo; el slug sniffing queda solo como fallback para la app legacy.

### G3. Pagos a empleados sin nombre explícito → sin `EmployeePayment`

**Evidencia:**
- El pago a empleado depende de que el LLM setee `empleado_gasto` o de que el texto matchee un empleado (`fuzzy-match.ts:219-220`, `backend_gal/main.py:4031-4043`).
- El `EmployeePayment` creado siempre es `mode="Variable"` (`backend_gal/main.py:4040`).

**Efecto:** "pagué el sueldo de 5000" sin nombre → Expense "Sueldos y salarios" sin `employee_id` → no se crea `EmployeePayment` y no aparece en el historial de pagos del empleado en galv2-tauri (SueldosTab).

**Propuesta:**
- Multi-turn: preguntar "¿A qué empleado?" cuando la categoría resuelve a "Sueldos y salarios" sin empleado vinculado.
- Permitir `mode` opcional en el payload (sueldo / adelanto).

### G4. El saldo/deuda pendiente depende del regex, no del LLM

**Evidencia:** el esquema del LLM no modela `saldo`; se fusiona desde el parse regex en `src/lib/expenses/index.ts:987-989`.

**Efecto:** si el regex no detecta el saldo, no se genera la deuda pendiente, aunque el LLM la haya entendido.

**Propuesta:**
- Añadir `saldo_pendiente` al esquema LLM y usarlo como fuente, con el regex como fallback; unificar en `ParsedExpense.saldo`.

### G5. Sin confirmación en auto-guardado

**Evidencia:** solo pide confirmación si el gasto es ambiguo (`isExpenseAmbiguous`, `src/lib/expenses/index.ts:1091`).

**Efecto:** una compra (genera deuda) o un pago a empleado que matchean todo se guardan solos, sin que el usuario confirme una operación con consecuencias contables.

**Propuesta:**
- Forzar confirmación cuando `tipo_gasto = compra` (genera deuda) o cuando hay pago a empleado vinculado.

### G6. Multi-turn no recolecta proveedor/empleado

**Evidencia:** el flujo de campos faltantes solo pregunta por monto y categoría (`src/lib/expenses/index.ts:1041-1089`). El `faltan_campos` del LLM soporta "proveedor", pero el handler no lo recolecta.

**Efecto:** una compra sin proveedor queda sin vincular (sin movimiento ni deuda); un sueldo sin empleado queda sin `EmployeePayment`.

**Propuesta:**
- Soportar `missingField: 'provider' | 'employee'` y extender `handleCollectingReply` + preview (`confirm-expense.ts`).

### G7. Sin soporte de stock (futuro)

**Evidencia:** el bot no crea movimientos `STOCK_IN`/`STOCK_OUT` ni actualiza `stock_qty`; galv2-tauri sí los maneja (ProveedoresTab).

**Propuesta (futura):** en G1, una compra a proveedor podría generar además un `STOCK_IN` con `quantity`.

### G8. Doble vía de escritura con galv2-tauri (futuro)

**Evidencia:** en galv2-tauri, `createExpense`/`getExpensesSummary`/`migrateExpenses` son código muerto (`src/lib/api/client.ts:443-453`); la app escribe movimientos legacy sin crear `Expense`. El bot escribe `Expense` → el backend crea movimientos.

**Efecto:** un "Pago Rápido"/"Compra Nueva" de la app no aparece en el KPI de gastos del período (ExpensesTab), mientras que los gastos del bot sí generan movimientos; ambas vías pueden divergir.

**Propuesta (futura):** migrar la app a `createExpense` y reconciliar el KPI de gastos con la deuda calculada sobre `movimientos_proveedor`.

## Anexo: alcance

- Se implementan los gaps 1-6.
- Gaps 7-8 quedan documentados y fuera de alcance por ahora.
- Cambios requeridos: wacrm (`src/lib/bot-llm/*`, `src/lib/expenses/*`, router del webhook) y `backend_gal/main.py` (mov_type/mode).
