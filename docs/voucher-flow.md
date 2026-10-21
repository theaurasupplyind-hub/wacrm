# Voucher Processing Pipeline

The voucher pipeline processes payment receipts (transfers, deposits) sent via
WhatsApp. It extracts payment data from images/PDFs using AI vision, matches
against pending invoices, and either auto-registers the payment or asks the
user for clarification.

## Architecture

```
WhatsApp Image/PDF
    │
    ▼
src/app/api/whatsapp/webhook/route.ts
    │  detects image/document → dispatches processVoucherMessage()
    ▼
src/lib/ai/voucher-pipeline.ts
    │  downloads media, extracts data, matches invoices
    ▼
src/lib/ai/voucher-extraction.ts   ← AI vision (OpenRouter/Gemini)
src/lib/ai/voucher-matching.ts     ← tolerance, sum matching
src/lib/facbal/client.ts           ← FacBal API (invoices, payments)
src/lib/ai/voucher-context.ts      ← multi-turn context (pending items)
```

## Pipeline Phases

> The source of truth for the phase model is the Spanish spec
> [`bots/vouchers.md`](./bots/vouchers.md). **Phases 1–3 only add entries to the
> candidate pool; none of them assigns `matchStatus`.** Phase 4 resolves by name
> and only phase 5 (wide search) runs if the pool is still empty. The decision is
> taken **inline** in the pipeline — there is no `resolvePoolDecision()` function.

### Phase 1 — Exact amount
Calls `matchVoucherByName` with tolerance 50. Adds invoices where
`saldo_pendiente === voucher.monto` to the candidate pool.

### Phase 2 — Client sum
Groups invoices with `saldo_pendiente < voucher.monto` by client name. Adds the
groups whose **sum** of balances equals the voucher amount exactly.

### Phase 3 — Name + amount
Calls `matchVoucherByName` with the extracted sender/recipient name. Adds
candidates with `score >= NAME_MATCH_THRESHOLD (0.5)` whose balance is within the
amount tolerance (or the caption forces the client).

### Phase 4 — Name resolution
Runs always, after phases 1–3:
- pool > 1 + reliable name → narrow the pool to the name-matching invoices;
- pool empty + reliable name → add the best name match;
- pool empty + a salvageable name (origin/destination/caption) → name-only search
  without amount filter ("phase 4b");
- no name → does nothing (phase 5 decides).

The caption only filters if it actually matches a candidate; it never vetoes by
itself.

## Decision Logic (inline)

The pipeline assigns `matchStatus` after phases 1–5. There is **no extracted
decision function**; the logic lives in `processVoucherImage` /
`processVoucherText`:

| Pool | Rule | Status |
|------|------|--------|
| 0 entries | Delegate to phase 5 (wide search) | — |
| 1 `single`, no name extracted | Single candidate, no contradiction | `matched` |
| 1 `single`, name extracted and matches | — | `matched` |
| 1 `single`, name extracted and does NOT match | `name_mismatch` | `ambiguous` |
| 1 `sum` | Confirm paying several invoices | `multi_invoice` |
| 2+ entries | Phase 4 filters by name score; if 1 remains → `matched`/`multi_invoice`, else ask | `ambiguous` |

### Phase 5 — Partial payment / wide search
Runs **only if the pool is empty** after phases 1–4. Uses `matchVoucherByName`
with `tolerance = min(max(10k, monto * 0.5), 50k)` and no name. Always shows
options (never auto-match): 1–15 candidates → `ambiguous`; >15 → ask for the
exact client name; API timeout → ask for the name; 0 candidates → `no_match`.

When the user replies with a name, `interpretUserResponse()` is applied over the
candidates already fetched (no new API call).

## Candidate Display (Letter Labels)

When candidates are shown to the user, each one is labeled with a letter
(A, B, C...) instead of numbers. The user responds with the letter.

```
Recibimos un pago de $62,000. Hay 3 clientes posibles...

A. Juan Perez — Factura F-001 — $62,000
B. Maria Garcia — Factura F-002 — $62,000
C. Carlos Lopez — Factura F-003 — $62,000

Respondé con la letra de la opción (A, B, C...).
```

### Response matching priority
1. **Letter** (A, B, C...) — exact case-insensitive match
2. **Invoice number** — substring match
3. **Name tokens** — any token overlap

For multi-invoice selection, multiple letters can be combined
(e.g., "AB", "A,B", "a b").

## Multi-Voucher Queue

When multiple voucher images arrive in sequence, the bot processes them as
a queue:

1. **Non-ambiguous** vouchers (auto-match) resolve immediately.
2. **Ambiguous** vouchers are queued in the pending context.
3. Only the **first** pending voucher's candidates are shown to the user.
4. When the user resolves it, the **next** pending voucher's candidates
   are shown automatically.
5. This continues until all pending vouchers are resolved.

### Defer mechanism
If a new ambiguous voucher arrives while others are already pending:
- The voucher is processed (extracted, matched, saved to pending)
- The candidates message is **suppressed**
- A brief "comprobante guardado" message is sent instead
- The candidates will be shown when previous vouchers are resolved

### Next-pending mechanism
When a voucher is resolved and there are more in the queue:
- The response message includes both the resolution confirmation AND
  the next voucher's candidates
- The user sees: "El comprobante fue procesado. Ahora, para el
  siguiente comprobante: [candidates]"

## Reset Command

Sending the text `jesusdanielllavesecreta` to the bot clears all pending
voucher context for that conversation (pending items + pending texts).

## Key Files

| File | Purpose |
|------|---------|
| `src/lib/ai/voucher-pipeline.ts` | Main pipeline (5 matching phases + inline decision + queue) |
| `src/lib/ai/voucher-extraction.ts` | AI extraction from receipt images/PDFs |
| `src/lib/ai/voucher-matching.ts` | Tolerance functions and sum matching |
| `src/lib/ai/voucher-context.ts` | Multi-turn context storage (pending items) |
| `src/lib/facbal/client.ts` | FacBal API client (invoices, payments, matching) |
| `src/app/api/whatsapp/webhook/route.ts` | WhatsApp webhook — dispatches to pipeline |
| `src/app/(dashboard)/voucher-debug/page.tsx` | Admin debug UI for pipeline tracing |

## Key Constants

| Constant | Value | Location |
|----------|-------|----------|
| `NAME_MATCH_THRESHOLD` | 0.5 | `voucher-matching.ts:3` |
| `MEDIA_TIMEOUT_MS` | 15,000 | `voucher-pipeline.ts:14` |
| `PENDING_TEXT_TTL_MS` | 60,000 | `voucher-context.ts:24` |
