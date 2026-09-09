-- Bot conversacional: aclaración pendiente ante intent ambiguo.
-- Una sola aclaración por conversación, con TTL de 5 minutos (ver CLARIFY_TTL_MS).
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS clarify_context jsonb;
