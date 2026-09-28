-- ============================================================
-- 048_bot_traces.sql — Trazas del flujo del bot para el diagrama
-- visual (/bot-flow).
--
-- Una fila por mensaje: el `path` (nodos visitados) y `steps` (detalle
-- por paso) son exactamente lo que renderiza React Flow. Los distintos
-- productores (webhook/router, voucher-pipeline, assistant) hacen
-- upsert por `message_id` para enriquecer la misma traza.
--
-- Seguridad: RLS habilitado SIN policies (deny-all para anon/authenticated).
-- El único acceso es server-side con service-role desde /api/bot-traces
-- (el service-role bypasea RLS), así que habilitarlo no rompe nada y evita
-- exponer la tabla al cliente.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS bot_traces (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id      text NOT NULL UNIQUE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  account_id      uuid,
  source          text,
  raw_text        text,
  status          text NOT NULL DEFAULT 'unknown',
  path            jsonb NOT NULL DEFAULT '[]'::jsonb,
  steps           jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_message   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bot_traces_conversation_id
  ON bot_traces (conversation_id);
CREATE INDEX IF NOT EXISTS idx_bot_traces_created_at
  ON bot_traces (created_at);
CREATE INDEX IF NOT EXISTS idx_bot_traces_status
  ON bot_traces (status);

-- Mantener updated_at al día en cada upsert.
CREATE OR REPLACE FUNCTION set_bot_traces_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_bot_traces_updated_at ON bot_traces;
CREATE TRIGGER trg_bot_traces_updated_at
  BEFORE UPDATE ON bot_traces
  FOR EACH ROW
  EXECUTE FUNCTION set_bot_traces_updated_at();

-- Deny-all para anon/authenticated (service-role bypasea RLS).
ALTER TABLE bot_traces ENABLE ROW LEVEL SECURITY;
