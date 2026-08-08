# Plan: Mejora de bots — Gastos y Asistencia (llegada/salida)

> Documento para un próximo agente. Implementa la mejora de los bots de
> **expenses** y **asistencia** de wacrm + el soporte de salida en `backend_gal`.
> Estado: implementado (fases A–D). Ver estado actual en
> [`architecture.md`](./architecture.md) §7, §10, §11.
> Contexto general: [`architecture.md`](./architecture.md) §2 (voice) y §10 (gastos).

## Alcance

1. **Asistencia**: registrar **salidas** (hoy solo llegada + estados), multi-turno
   para empleado no encontrado, dedupe/validación de secuencia.
2. **Gastos**: parser de montos robusto + **confirmación interactiva solo ante
   ambigüedad**.
3. **Backend** (`backend_gal`, repo aparte): soporte de salida en `asistencias`.

## Decisiones tomadas (confirmadas con el dueño)

- **Salida sin llegada previa ese día** → rechazar ("Primero registrá tu llegada").
- **Segunda llegada el mismo día** → preguntar antes con botones
  [✅ Corregir hora] [❌ No tocar] (no sobrescribir a ciegas).
- **Confirmación de gastos** → **solo si hay ambigüedad** (categoría nueva,
  proveedor/empleado ambiguo, monto dudoso). Si todo está claro → auto-guardar
  como hoy.

## Estado actual relevado

- `src/lib/attendance/` — `index.ts` + `parse-attendance.ts`. Solo llegadas
  ("llegó X a las HH:MM" → `status`, marca `TARDE-HH:MM` contra `entry_time` +
  `late_threshold`) y estados (vacaciones/licencia/ausente). Sin salida, sin
  multi-turno, sin dedupe, sin auditoría en Supabase.
  - Bug: `extractEmployeeName` toma solo texto **antes** de la keyword →
    "llegó juan" devuelve `null` y el bot falla.
- Backend (`backend_gal/main.py`):
  - `Attendance` (tabla `asistencias`): `{id, employee_id, date, status, created_at}`,
    **una fila por empleado+día, un solo `status`**. `POST /attendance` es **upsert**
    (pisa `status`). No hay campo de salida.
  - `Employee` tiene `entry_time`, `exit_time`, `late_threshold`.
  - `GET /attendance?employee_id=&month=`; `DELETE /attendance?employee_id=&date=`.
  - Expenses: CRUD completo (`POST/PUT/DELETE /expenses/{eid}`) — no bloquea.
  - Patrón de ALTER en startup: líneas ~1063-1070.
- wacrm gastos: `src/lib/expenses/` — texto (regex), audio (Whisper),
  imagen/PDF (Gemini Vision), multi-turno en `expense_context`, fuzzy-match de
  categorías/proveedores/empleados, auditoría en `expense_extractions`
  (migración 037), saldo/deuda. Guarda **sin confirmación**. Parser de monto
  elige "el número más grande" (`parse-expense.ts:49-60`).
- Infra disponible: `engineSendInteractiveButtons()` (`src/lib/flows/meta-send.ts:298`,
  `InteractiveButton = {id, title}` desde `src/lib/whatsapp/meta-api.ts:735`).
- Migración Supabase siguiente libre: **044**.

---

## Fase A — Backend `backend_gal/main.py` (bloqueante para salida)

- **A1** Modelo `Attendance`: agregar `exit_time = Column(String, nullable=True)`.
  En el bloque de startup (junto a las líneas 1063-1070):
  `ALTER TABLE asistencias ADD COLUMN IF NOT EXISTS exit_time VARCHAR;`
- **A2** `AttendanceCreate`: agregar `exit_time: Optional[str] = None`.
- **A3** `POST /attendance` (upsert, líneas ~3755): si la fila existe y viene
  `exit_time`, setearlo (no pisar `status` si no viene).
- **A4** `GET /attendance` (línea ~3739): agregar filtro opcional `date` y
  devolver `exit_time` en la respuesta.

## Fase B — wacrm: Asistencia (`src/lib/attendance/`)

- **B1** `parse-attendance.ts`
  - `AttendanceStatusType` agrega `'departure'`.
  - Keywords de salida: `salgo`, `sale`, `salí`, `salida`, `me voy`, `terminé`,
    `me retiro`, `chau`. Detectar `arrival` vs `departure`; extraer hora en ambos.
  - Fix nombre: capturar empleado también **después** de la keyword
    ("llegó juan", "juan se fue", "se fue juan").
  - Agregar `parse-attendance.test.ts` (hoy no existe).
- **B2** `index.ts` (`processAttendanceMessage`)
  - Llegada: como hoy (hora + `TARDE-`).
  - Salida: `createAttendance` con `exit_time`; respuesta con hora (y aviso si
    difiere del `exit_time` esperado del empleado).
  - Secuencia: **salida sin llegada previa** (status tipo hora) → rechazar y
    responder "Primero registrá tu llegada" (`handled: true`).
  - Dedupe: **segunda llegada** el mismo día → `engineSendInteractiveButtons`
    [✅ Corregir hora] [❌ No tocar], guardar contexto de corrección y esperar.
- **B3** Nuevo `context.ts` (patrón de `src/lib/expenses/context.ts`) + migración
  **`supabase/migrations/044_attendance_context.sql`**: columna
  `conversations.attendance_context jsonb`. Estado:
  `{ pendingEmployee?, pendingType?: 'arrival'|'departure'|'vacaciones'|'licencia'|'ausente',
     pendingDate?, pendingTime?, awaitingCorrection?: boolean, existingEmployeeId?,
     existingStatus? }`.
  - Empleado no encontrado/ambiguo → guardar y preguntar "¿De quién es?"; el
    próximo texto resuelve (reintenta `searchEmployees`).
- **B4** `src/lib/facbal/client.ts`
  - `createAttendance(record)` acepta `exit_time`.
  - Nueva `getAttendance(employeeId, date)` → `GET /attendance?employee_id=&date=`
    (usar filtro `date` de A4) para dedupe/secuencia.
- **B5** `src/app/api/whatsapp/webhook/route.ts`
  - Cargar `hasPendingAttendance` (como `hasPendingExpense`).
  - Ruteo: si `interactiveReplyId` y `attendanceCtx.awaitingCorrection` → manejar
    en el handler de asistencia (✅ = sobrescribir, ❌ = dejar) y marcarlo
    consumido **antes** de `dispatchInboundToFlows`.
  - Sumar `hasPendingAttendance` a `shouldSuppressVoiceOrder`
    (`src/lib/bot-coordination.ts`) para que la respuesta del multi-turno no caiga
    en voice orders.

## Fase C — wacrm: Gastos (`src/lib/expenses/`)

- **C1** `parse-expense.ts` — parser de montos robusto:
  - "18 mil"/"18k"/"18 m" → 18000; "$18.000,00" (AR) y "18,000.00" (US);
    decimales con coma o punto según contexto.
  - Priorizar el número pegado a palabras de dinero (`pagué $X`, `costo X`,
    `gasté X`, `transferí X`).
  - Excluir números de fechas y de cantidades en la descripción.
  - Actualizar `parse-expense.test.ts`.
- **C2** Confirmación interactiva por ambigüedad:
  - `index.ts` `processExpenseMessage`: después de parse + `fuzzyMatchExpense`,
    si hay **ambigüedad** (categoría recién creada, proveedor/empleado ambiguo,
    o monto dudoso del parser) → **no ejecutar**; enviar preview
    (`buildExpensePreview`) con botones [✅ Confirmar] [✏️ Corregir] [❌ Cancelar]
    y guardar contexto `stage: 'confirming'`. Si todo está claro → flujo actual.
  - `types.ts`: completar uso de `stage: 'confirming'` en `ExpenseStage` (ya existe).
  - `webhook/route.ts`: si `interactiveReplyId` y `expenseCtx.stage==='confirming'`
    → manejar en el handler de gastos (antes de flows) y marcarlo consumido.
    - ✅ Confirmar → ejecutar + auditar (`expense_extractions`) + confirmación final.
    - ✏️ Corregir → volver a `collecting` preguntando qué campo.
    - ❌ Cancelar → `clearExpenseContext`.

## Fase D — Docs

- Actualizar `docs/bots/architecture.md` (§2 asistencia, §10 gastos) con el estado
  nuevo (salida, multi-turno, dedupe, confirmación por ambigüedad).
- Actualizar `docs/bots/README.md` si cambia el mapa de sistemas.

## Orden de implementación

1. Fase A (backend) → 2. Fase B (asistencia) → 3. Fase C (gastos) → 4. Fase D.

## Verificación

- Backend: levantar `main.py` con `local_test.db`/`local_test_expenses.db` y probar
  con curl: POST /attendance con/sin `exit_time`, upsert, GET con `date`.
- wacrm:
  ```bash
  npm run typecheck
  npm run lint
  npm run test        # incluye parse-attendance.test.ts y parse-expense.test.ts
  npm run build
  ```
- Escenarios WhatsApp a probar:
  - "llegó juan a las 8:30" y "juan llegó a las 8:30" (fix de orden).
  - "me voy a las 17:00" con y sin llegada previa.
  - Segunda "llegó" el mismo día → botones; ✅ sobrescribe, ❌ no toca.
  - "pagué 18 mil de luz" → monto 18000; gasto claro → auto-guardar.
  - Gasto con categoría nueva/ambigua → botones; Confirmar/Corregir/Cancelar.

## Archivos tocados (resumen)

| Archivo | Cambio |
|---------|--------|
| `backend_gal/main.py` | `exit_time` en modelo/schema/upsert/GET + filtro `date` |
| `src/lib/attendance/parse-attendance.ts` | Salida, fix nombre, tests nuevos |
| `src/lib/attendance/index.ts` | Salida, secuencia, dedupe, multi-turno |
| `src/lib/attendance/context.ts` | (nuevo) estado `attendance_context` |
| `supabase/migrations/044_attendance_context.sql` | (nueva) columna `attendance_context` |
| `src/lib/facbal/client.ts` | `createAttendance` exit_time + `getAttendance(employeeId,date)` |
| `src/lib/bot-coordination.ts` | `hasPendingAttendance` en suppression |
| `src/app/api/whatsapp/webhook/route.ts` | Ruteo interactive replies (asistencia + gastos) |
| `src/lib/expenses/parse-expense.ts` | Parser de montos robusto |
| `src/lib/expenses/index.ts` | Confirmación por ambigüedad (`stage:'confirming'`) |
| `src/lib/expenses/types.ts` | Uso de `stage:'confirming'` |
| `src/lib/expenses/parse-expense.test.ts` | Tests de montos |
| `docs/bots/architecture.md` | Estado asistencia/gastos |
