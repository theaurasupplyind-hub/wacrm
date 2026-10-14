-- ============================================================
-- 054_bot_pending_confirms.sql — Confirmaciones pendientes del agente
-- (Fase 4 del plan agente-conversacional).
--
-- Cuando el gate de efectos exige confirmación, la vía del agente guarda acá
-- la operación pendiente (tool + args originales) en vez de ejecutarla. El
-- usuario confirma ("dale") o cancela ("mejor no") en el turno siguiente; el
-- agente consume la fila y ejecuta con los args GUARDADOS (nunca los que el
-- modelo proponga en el turno de confirmación).
--
-- Seguridad: RLS habilitado SIN policies (deny-all para anon/authenticated),
-- igual que bot_traces (048). Acceso server-side con service-role.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS bot_pending_confirms (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id      uuid,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  tool            text NOT NULL,
  args            jsonb NOT NULL DEFAULT '{}'::jsonb,
  preview         text NULL,
  status          text NOT NULL DEFAULT 'pending',
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '15 minutes'
);

CREATE INDEX IF NOT EXISTS idx_bot_pending_confirms_conversation_id
  ON bot_pending_confirms (conversation_id);
CREATE INDEX IF NOT EXISTS idx_bot_pending_confirms_status
  ON bot_pending_confirms (status);

ALTER TABLE bot_pending_confirms ENABLE ROW LEVEL SECURITY;
