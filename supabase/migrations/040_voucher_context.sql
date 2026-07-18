-- Voucher processing context: estado entre mensajes (candidatos pendientes, confirmación)
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS voucher_context jsonb;
