-- ============================================================
-- 052_bot_write_log.sql — Log de escrituras del bot para undo 24h
-- (Fase 2 del plan agente-conversacional).
--
-- Una fila por escritura del bot (gasto/asistencia/factura/pago) con lo
-- necesario para deshacerla dentro de la ventana de 24h: la entidad y su
-- id/clave en backend_gal. La usa `deshacer_ultima_operacion` y la Fase 3
-- (failure trace) para referenciar qué acción se corrigió.
--
-- Seguridad: RLS habilitado SIN policies (deny-all para anon/authenticated),
-- igual que bot_traces (048). Acceso server-side con service-role.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS bot_write_log (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id      uuid,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  entity          text NOT NULL,
  entity_id       bigint NULL,
  entity_key      text NULL,
  summary         text NULL,
  undone_at       timestamptz NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bot_write_log_conversation_id
  ON bot_write_log (conversation_id);
CREATE INDEX IF NOT EXISTS idx_bot_write_log_created_at
  ON bot_write_log (created_at);
CREATE INDEX IF NOT EXISTS idx_bot_write_log_entity
  ON bot_write_log (entity);

ALTER TABLE bot_write_log ENABLE ROW LEVEL SECURITY;
