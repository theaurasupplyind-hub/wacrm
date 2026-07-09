-- ============================================================
-- 032_chatbot_logs.sql — Logs de depuración del chatbot
--
-- Guarda cada paso del pipeline del chatbot (detección de intención,
-- consulta a suggestPrice, respuesta directa vs OpenRouter, errores).
-- Permite auditar el comportamiento del bot desde un panel de debug
-- sin necesidad de enviar mensajes reales.
--
-- Schema:
--   phone         — Teléfono del remitente (últimos 6 dígitos).
--   message_text  — Mensaje original del cliente (truncado a 200 chars).
--   step          — Etapa del pipeline:
--                     'intent_detected'
--                     'suggest_price'
--                     'direct_response'
--                     'openrouter_response'
--                     'error'
--   data          — Payload JSON con los resultados de cada etapa.
--   duration_ms   — Tiempo de ejecución del paso en milisegundos.
--   account_id    — Tenant (para filtrar por cuenta).
--
-- RLS: solo miembros autenticados del account pueden leer.
-- Las inserciones se hacen con service-role desde el webhook.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS chatbot_logs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at    timestamptz NOT NULL DEFAULT now(),
  phone         text NOT NULL,
  message_text  text,
  step          text NOT NULL,
  data          jsonb,
  duration_ms   integer,
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chatbot_logs_account_id
  ON chatbot_logs (account_id);

CREATE INDEX IF NOT EXISTS idx_chatbot_logs_created_at
  ON chatbot_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_chatbot_logs_phone
  ON chatbot_logs (phone);

CREATE INDEX IF NOT EXISTS idx_chatbot_logs_step
  ON chatbot_logs (step);
