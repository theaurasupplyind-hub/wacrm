-- ============================================================
-- 049_drop_voice_context.sql — Elimina el contexto de "pedidos por voz".
--
-- El flujo de pedidos/presupuestos (voice-orders) se removió del bot: ya no
-- hay dominio 'voice'. La columna `conversations.voice_context` queda sin uso.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE conversations DROP COLUMN IF EXISTS voice_context;
