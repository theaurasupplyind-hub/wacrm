-- ============================================================
-- 045_bot_debug_logs.sql — Logs de auditoría del router unificado
-- y de los bots de gastos y asistencia.
--
-- Complementa el patrón de voucher_extractions (031/041/042):
--   router_logs          → decisión de dispatch por mensaje de texto
--                          (extractor LLM unificado).
--   attendance_extractions → cada evento del flujo de asistencia
--                          (registrado, pregunta de empleado/hora,
--                          corrección, error, etc.).
--   expense_extractions  → se amplía con debug_info / extractor_source /
--                          confianza para el log detallado de gastos.
--
-- RLS: igual que voucher_extractions — solo admin+ puede leer (auditoría).
-- Las inserciones se hacen desde el webhook con service-role client.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS router_logs (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id        text,
  contact_id        uuid NOT NULL REFERENCES contacts(id),
  conversation_id   uuid REFERENCES conversations(id),
  account_id        uuid,
  raw_text          text,
  source            text,
  flow_consumed     boolean NOT NULL DEFAULT false,
  interactive       boolean NOT NULL DEFAULT false,
  had_context       boolean NOT NULL DEFAULT false,
  extractor_source  text,
  intent            text,
  confianza         text,
  dudoso            boolean NOT NULL DEFAULT false,
  faltan_campos     jsonb,
  dispatched_to     text,
  dispatch_reason   text,
  debug_info        jsonb,
  error_message     text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_router_logs_message_id
  ON router_logs (message_id);
CREATE INDEX IF NOT EXISTS idx_router_logs_conversation_id
  ON router_logs (conversation_id);
CREATE INDEX IF NOT EXISTS idx_router_logs_created_at
  ON router_logs (created_at);

CREATE TABLE IF NOT EXISTS attendance_extractions (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id             text,
  contact_id             uuid NOT NULL REFERENCES contacts(id),
  conversation_id        uuid REFERENCES conversations(id),
  raw_text               text,
  intent                 text,
  extractor_source       text,
  employee_name          text,
  time                   text,
  date                   text,
  status_type            text,
  faltan_campos          jsonb,
  outcome                text,
  matched_employee_id    integer,
  matched_employee_name  text,
  error_message          text,
  debug_info             jsonb,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attendance_extractions_message_id
  ON attendance_extractions (message_id);
CREATE INDEX IF NOT EXISTS idx_attendance_extractions_conversation_id
  ON attendance_extractions (conversation_id);
CREATE INDEX IF NOT EXISTS idx_attendance_extractions_created_at
  ON attendance_extractions (created_at);

ALTER TABLE expense_extractions
  ADD COLUMN IF NOT EXISTS debug_info jsonb,
  ADD COLUMN IF NOT EXISTS extractor_source text,
  ADD COLUMN IF NOT EXISTS confianza text;
