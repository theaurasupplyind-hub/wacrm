-- ============================================================
-- 043_voucher_atomic_pending.sql
-- Funciones PL/pgSQL para operaciones atómicas sobre el array
-- JSONB voucher_context.pending, evitando race conditions
-- cuando múltiples vouchers se procesan concurrentemente
-- para la misma conversación (bgTasks en Promise.allSettled).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE OR REPLACE FUNCTION voucher_append_pending(
  conv_id uuid,
  new_item jsonb
) RETURNS void AS $$
BEGIN
  UPDATE conversations
  SET voucher_context = jsonb_set(
    COALESCE(voucher_context, '{"pending":[],"pendingTexts":[]}'::jsonb),
    '{pending}',
    COALESCE(voucher_context->'pending', '[]'::jsonb) || new_item
  )
  WHERE id = conv_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION voucher_remove_pending(
  conv_id uuid,
  msg_id text
) RETURNS void AS $$
BEGIN
  UPDATE conversations
  SET voucher_context = jsonb_set(
    voucher_context,
    '{pending}',
    COALESCE(
      (SELECT jsonb_agg(el)
       FROM jsonb_array_elements(voucher_context->'pending') el
       WHERE el->>'sourceMessageId' <> msg_id),
      '[]'::jsonb
    )
  )
  WHERE id = conv_id;
END;
$$ LANGUAGE plpgsql;
