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

### Phase 1 — Exact amount
Calls `matchVoucherByName` with tolerance 50. Filters to invoices where
`saldo_pendiente === voucher.monto` (exact match). Adds exact matches to the
candidate pool.

### Phase 2 — Client sum
Scans all invoices with `saldo_pendiente < voucher.monto`. Groups by client
name. Finds groups where the **sum** of invoice balances equals the voucher
amount exactly. Adds matching sum-groups to the candidate pool.

### Phase 3 — Name + amount
Calls `matchVoucherByName` with the extracted sender/recipient name.
Filters to candidates with `score >= NAME_MATCH_THRESHOLD (0.5)`. Candidates
are added to the pool regardless of amount distance (the high name score is
trusted over exact amount match).

### Phase 4 — Name resolution
If the pool has entries and a reliable name was extracted, tries to narrow
down to a single candidate:
- **Pool > 1 entry + reliable name**: filters pool entries to only those
  whose invoices have `score >= NAME_MATCH_THRESHOLD` from Phase 3.
  If exactly 1 remains — auto-select.
- **Pool empty + reliable name**: adds the best name-matched candidate
  from Phase 3 to the pool.
- **Pool empty + no reliable name**: asks the user for the client name
  directly (skips Phase 5).

### Phase 5 — Wide search / fallback
Only runs if Phase 4 left the pool empty. Uses a wide tolerance
(`min(max(10k, monto * 0.5), 50k)`). Filters to invoices with
`saldo_pendiente >= monto`. Shows up to 15 candidates to the user.

## Decision Logic

After phases 1-5, the pool determines the result:

| Pool size | Match status | Behavior |
|-----------|-------------|----------|
| 0 | `no_match` | Reports no match found |
| 1 (single) | `matched` | Auto-registers payment |
| 1 (single, name mismatch) | `ambiguous` | Asks user to confirm |
| 1 (sum) | `multi_invoice` | Asks user to confirm paying multiple invoices |
| >1 | `ambiguous` | Shows candidates to user |

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
| `src/lib/ai/voucher-pipeline.ts` | Main pipeline (5 matching phases + decision + queue) |
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
