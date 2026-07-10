-- ============================================================
-- 034_chatbot_pending_batches.sql — Debounce de mensajes del chatbot
--
-- El webhook escribe aquí el texto acumulado de mensajes fragmentados
-- antes de esperar 8s. El que tenga la última marca de tiempo
-- procesa el batch. Limpieza automática para filas viejas.
-- ============================================================

CREATE TABLE IF NOT EXISTS chatbot_pending_batches (
  conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  accumulated_text text NOT NULL,
  last_message_at timestamptz NOT NULL DEFAULT now()
);

-- Muchas filas pueden pegarse si el cron no corre; la tabla es chica.
-- Solo indexamos la columna de limpieza.
CREATE INDEX IF NOT EXISTS idx_cpb_last_message_at
  ON chatbot_pending_batches(last_message_at);

-- Limpieza: filas con más de 10 minutos son huérfanas (se colgó o
-- falló). El bot reintenta con el acumulado que haya, así que nunca
-- debería haber filas vivas más de ~20s en condiciones normales.
-- 10 min es margen amplio para edge cases.
CREATE OR REPLACE FUNCTION cleanup_chatbot_pending_batches()
RETURNS void AS $$
BEGIN
  DELETE FROM chatbot_pending_batches
  WHERE last_message_at < now() - interval '10 minutes';
END;
$$ LANGUAGE plpgsql;
