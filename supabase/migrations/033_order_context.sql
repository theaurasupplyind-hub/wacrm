-- ============================================================
-- 033_order_context.sql — Estado de pedido por conversación
--
-- Guarda un resumen estructurado del pedido en curso (producto,
-- medidas, presupuesto, estado del pago, fechas, etc.) para que
-- el bot tenga contexto de largo plazo sin gastar tokens cargando
-- todo el historial de mensajes.
--
-- El bot lo actualiza automáticamente con los datos "seguros" que
-- vienen de la API de precios. Jorge puede corregirlo manualmente.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS order_context jsonb DEFAULT '{}'::jsonb;
