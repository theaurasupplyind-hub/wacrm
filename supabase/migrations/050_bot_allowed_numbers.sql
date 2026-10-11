-- ============================================================
-- 050_bot_allowed_numbers.sql — Whitelist de números autorizados del bot.
--
-- Solo los números (teléfonos) cargados acá pueden disparar el bot
-- determinístico (gastos / asistencia / voucher / asistente). El resto de
-- los contactos (clientes) sigue por Flows / AI auto-reply y NO recibe
-- respuesta del bot.
--
-- Gate: `src/lib/bot/whitelist.ts` (isPhoneAllowed) + `route.ts` del webhook.
--
-- Seguridad: RLS con `is_account_member` (migración 017). Lectura para
-- cualquier miembro de la cuenta; escritura solo admin. El webhook usa
-- service-role (bypasea RLS) para el gate de lectura.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS bot_allowed_numbers (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Teléfono normalizado (solo dígitos, ver normalizePhone). Ej: "5491130000000".
  phone       text NOT NULL,
  -- Etiqueta humana: "Jesús (dueño)", "Taller", etc.
  label       text,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Un número no puede estar duplicado dentro de la misma cuenta.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_allowed_numbers_account_phone
  ON bot_allowed_numbers (account_id, phone);

-- Lookup del gate: cuenta + número activo.
CREATE INDEX IF NOT EXISTS idx_bot_allowed_numbers_lookup
  ON bot_allowed_numbers (account_id, phone)
  WHERE active = true;

ALTER TABLE bot_allowed_numbers ENABLE ROW LEVEL SECURITY;

-- Re-runnable: Postgres no tiene CREATE POLICY IF NOT EXISTS.
DROP POLICY IF EXISTS bot_allowed_numbers_select ON bot_allowed_numbers;
DROP POLICY IF EXISTS bot_allowed_numbers_insert ON bot_allowed_numbers;
DROP POLICY IF EXISTS bot_allowed_numbers_update ON bot_allowed_numbers;
DROP POLICY IF EXISTS bot_allowed_numbers_delete ON bot_allowed_numbers;

CREATE POLICY bot_allowed_numbers_select ON bot_allowed_numbers
  FOR SELECT USING (is_account_member(account_id));

CREATE POLICY bot_allowed_numbers_insert ON bot_allowed_numbers
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));

CREATE POLICY bot_allowed_numbers_update ON bot_allowed_numbers
  FOR UPDATE USING (is_account_member(account_id, 'admin'));

CREATE POLICY bot_allowed_numbers_delete ON bot_allowed_numbers
  FOR DELETE USING (is_account_member(account_id, 'admin'));
