-- Voice orders context: estado entre mensajes (variantes pendientes, confirmación)
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS voice_context jsonb;
