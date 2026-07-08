-- ============================================================
-- 031_voucher_extractions.sql — Auditoría de comprobantes de pago
--
-- Guarda el resultado de cada intento de extracción de comprobante
-- vía IA (OpenRouter). Permite auditar qué leyó la IA de cada
-- imagen/PDF recibido y si se pudo matchear con alguna factura.
--
-- Schema:
--   message_id         — WhatsApp message ID (Meta), permite
--                        correlacionar con la tabla `messages`.
--   contact_id         — FK a `contacts`, para saber de qué cliente
--                        es el comprobante.
--   extracted_amount   — Monto que la IA leyó del comprobante.
--   extracted_date     — Fecha leída por la IA.
--   extracted_reference— Número de operación o referencia.
--   extracted_bank     — Banco o billetera identificado.
--   match_status       — Resultado del matching:
--                          'matched'   → pagó automáticamente
--                          'ambiguous' → hay varias facturas candidatas
--                          'no_match'  → sin facturas pendientes o
--                                        monto no coincide
--   matched_invoice_id — Invoice ID de FacBal si fue matched.
--
-- RLS: solo admin+ puede leer (para auditoría). Las inserciones se
-- hacen desde el webhook con service-role client.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS voucher_extractions (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id        text NOT NULL,
  contact_id        uuid NOT NULL REFERENCES contacts(id),
  extracted_amount  numeric(12,2),
  extracted_date    text,
  extracted_reference text,
  extracted_bank    text,
  match_status      text NOT NULL CHECK (match_status IN ('matched', 'ambiguous', 'no_match')),
  matched_invoice_id integer,
  error_message     text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_voucher_extractions_message_id
  ON voucher_extractions (message_id);

CREATE INDEX IF NOT EXISTS idx_voucher_extractions_contact_id
  ON voucher_extractions (contact_id);
