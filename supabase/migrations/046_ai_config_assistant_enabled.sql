-- 046_ai_config_assistant_enabled.sql — flag rollout asistente conversacional
-- Idempotente.
ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS assistant_enabled boolean NOT NULL DEFAULT true;

-- Comentario para operadores: true = asistente on (default rollout), false = off por cuenta (rollback)
COMMENT ON COLUMN ai_configs.assistant_enabled IS 'Bot Beta assistant enabled por cuenta. On por defecto, off reversible por cuenta.';
