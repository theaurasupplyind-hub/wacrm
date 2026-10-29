-- ============================================================
-- 055_voucher_awaiting_match.sql
--
-- Estado del voucher por texto cuando NO se encontró la factura:
-- "no encontré facturas para Martu, ¿me pasás el monto o el nombre completo?".
-- Guarda el método/fecha/destino del pago original para reintentar sin pedir
-- todo de nuevo. TTL corto (5 min) controlado en `voucher-context.ts`.
--
-- Columna separada (no dentro de voucher_context) para no pisar el array
-- `pending` con read-modify-write.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS voucher_awaiting_match jsonb;
