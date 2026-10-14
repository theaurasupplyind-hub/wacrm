-- ============================================================
-- 053_bot_failure_traces.sql — Trace de fallos del bot (Fase 3 del plan
-- agente-conversacional).
--
-- Una fila por señal de corrección del usuario ("te equivocaste", "no era
-- eso", ...) detectada en el webhook (sombra, sin cambiar el dispatch).
-- La resolución se completa cuando una tool de corrección (deshacer/editar/
-- eliminar) se ejecuta en la misma conversación, o en la revisión semanal.
-- Cada fallo resuelto alimenta fixtures de regresión (Fase 3) y vocabulario
-- (Fase 6).
--
-- Seguridad: RLS habilitado SIN policies (deny-all para anon/authenticated),
-- igual que bot_traces (048). Acceso server-side con service-role.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS bot_failure_traces (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id      uuid,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  message_id      text,
  signal_text     text NOT NULL,
  reporter        text NOT NULL DEFAULT 'bot_error',
  failure_class   text NULL,
  write_log_id    bigint NULL REFERENCES bot_write_log(id) ON DELETE SET NULL,
  resolution      text NOT NULL DEFAULT 'pending',
  resolution_detail text NULL,
  intent          text NULL,
  confianza       text NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz NULL
);

CREATE INDEX IF NOT EXISTS idx_bot_failure_traces_conversation_id
  ON bot_failure_traces (conversation_id);
CREATE INDEX IF NOT EXISTS idx_bot_failure_traces_created_at
  ON bot_failure_traces (created_at);
CREATE INDEX IF NOT EXISTS idx_bot_failure_traces_resolution
  ON bot_failure_traces (resolution);
CREATE INDEX IF NOT EXISTS idx_bot_failure_traces_class
  ON bot_failure_traces (failure_class);

ALTER TABLE bot_failure_traces ENABLE ROW LEVEL SECURITY;
