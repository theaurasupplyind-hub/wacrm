-- Expense Bot context: estado entre mensajes (gasto pendiente de confirmación/corrección)
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS expense_context jsonb;
