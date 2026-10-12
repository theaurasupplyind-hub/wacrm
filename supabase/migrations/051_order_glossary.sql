-- ============================================================
-- 051_order_glossary.sql — Glosario de términos de pedido (aprendido).
--
-- Cuando el bot no entiende una forma de nombrar un producto ("moldura de 4"),
-- pregunta y guarda el significado. En pedidos futuros lo aplica solo.
--
-- meaning jsonb:
--   {"type":"grosor","value":4}            → grosor 4cm
--   {"type":"alias","value":"doble 4cm"}   → se reemplaza por ese texto
--
-- RLS deny-all (service-role bypasea), igual que bot_traces.
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS order_glossary (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id    uuid NOT NULL,
  term_norm     text NOT NULL,
  term_display  text NOT NULL,
  meaning       jsonb NOT NULL,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, term_norm)
);

CREATE INDEX IF NOT EXISTS idx_order_glossary_account
  ON order_glossary (account_id);

ALTER TABLE order_glossary ENABLE ROW LEVEL SECURITY;
