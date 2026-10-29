-- ============================================================
-- 056_conversation_bot_last_turn.sql — Último turno del bot
-- (fallback determinístico → agente con tools).
--
-- Guarda el desenlace del último turno de la conversación:
--   { messageId, text, domain, reason, status, at, fallbackFrom? }
--
-- Dispara dos caminos:
--   1. Si el handler determinístico no respondió (declined/no_reply/error),
--      el agente con tools responde en el mismo turno.
--   2. Si el usuario reintenta después de un callejón sin salida
--      (replied_dead_end), el agente toma el mensaje siguiente con contexto.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS bot_last_turn jsonb;

COMMENT ON COLUMN conversations.bot_last_turn IS
  'Desenlace del último turno del bot (fallback/retry). Ver src/lib/bot/turn-outcome.ts';
