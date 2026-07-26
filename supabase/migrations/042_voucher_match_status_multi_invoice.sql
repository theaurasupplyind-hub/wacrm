-- ============================================================
-- 042_voucher_match_status_multi_invoice.sql
-- Ampliar CHECK constraint de voucher_extractions.match_status
-- para incluir 'multi_invoice'.
--
-- Antes: CHECK (match_status IN ('matched', 'ambiguous', 'no_match'))
-- Ahora: CHECK (match_status IN ('matched', 'ambiguous', 'no_match', 'multi_invoice'))
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE voucher_extractions
  DROP CONSTRAINT IF EXISTS voucher_extractions_match_status_check;

ALTER TABLE voucher_extractions
  ADD CONSTRAINT voucher_extractions_match_status_check
  CHECK (match_status IN ('matched', 'ambiguous', 'no_match', 'multi_invoice'));
