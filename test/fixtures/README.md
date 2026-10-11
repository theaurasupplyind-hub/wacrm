# Fixtures de replay (no versionados)

Los archivos `router-logs.json` y `voucher-extractions.json` se exportan desde
Supabase y **no se commitean** porque contienen datos reales de clientes (PII:
teléfonos, nombres, montos, facturas). Están en `.gitignore`.

## Exportar (Supabase → SQL Editor → New query)

`router-logs.json`:

```sql
select coalesce(json_agg(row_to_json(t)), '[]'::json) as json
from (
  select
    rl.message_id, rl.raw_text, rl.source, rl.flow_consumed, rl.interactive,
    rl.had_context, rl.intent, rl.confianza, rl.dispatched_to, rl.dispatch_reason,
    rl.debug_info->'context_text' as context_text,
    rl.debug_info->'extraction'   as extraction,
    c.phone                       as contact_phone,
    rl.created_at
  from router_logs rl
  left join contacts c on c.id = rl.contact_id
  where rl.raw_text is not null
    and rl.source <> 'assistant'
  order by rl.created_at desc
  limit 500
) t;
```

`voucher-extractions.json`:

```sql
select coalesce(json_agg(row_to_json(t)), '[]'::json) as json
from (
  select message_id, match_status, extracted_amount, extracted_date,
         extracted_reference, extracted_bank, debug_info, created_at
  from voucher_extractions
  order by created_at desc
  limit 500
) t;
```

Copiá el contenido de la celda `json` y guardalo en `test/fixtures/router-logs.json`
y `test/fixtures/voucher-extractions.json` respectivamente. (El loader acepta el
formato `[{ "json": [...] }]`, `{ "json": [...] }` o un array plano.)

## Correr

- Determinístico (usa la extracción guardada, sin LLM):
  `npx vitest run src/lib/bot-llm/replay.test.ts src/lib/ai/voucher-replay.test.ts`
- Live end-to-end (requiere `OPENROUTER_API_KEY`, 1 llamada LLM por caso):
  ```powershell
  $env:OPENROUTER_API_KEY="..."; $env:REPLAY_LIMIT=100; npx vitest run src/lib/bot-llm/replay.live --disableConsoleIntercept
  ```

Sin fixtures, los tests se saltean automáticamente.
