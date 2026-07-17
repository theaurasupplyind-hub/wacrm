-- Auditoría de extracciones de gastos del bot
CREATE TABLE IF NOT EXISTS expense_extractions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id text,
    contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
    conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
    raw_text text,
    extracted_amount numeric,
    extracted_category text,
    extracted_provider text,
    extracted_employee text,
    extracted_payment_method text,
    extracted_reference text,
    match_status text DEFAULT 'pending', -- pending, confirmed, cancelled, ambiguous, error
    matched_expense_id integer,
    error_message text,
    created_at timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_expense_extractions_contact_id ON expense_extractions(contact_id);
CREATE INDEX IF NOT EXISTS idx_expense_extractions_conversation_id ON expense_extractions(conversation_id);
CREATE INDEX IF NOT EXISTS idx_expense_extractions_created_at ON expense_extractions(created_at);
