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
candidates with `score >= NAME_MATCH_THRESHOLD (0.5)` **or** a local name match (prefix/tokens) whose balance is within the
amount tolerance (or the caption forces the client).

A local-only name match (`score < 0.5` but prefix/token match) is **weak**: the
text path asks for confirmation (client + invoice + balance) instead of paying.

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
| 1 `single`, weak name (score < 0.5 but prefix/token match) | confirm client/invoice | `ambiguous` |
| 1 `single`, no name but amount (text path) | confirm client/invoice | `ambiguous` |
| 1 `sum` | Confirm paying several invoices | `multi_invoice` |
| 2+ entries | Phase 4 filters by name score; if 1 remains → `matched`/`multi_invoice`, else ask | `ambiguous` |

> In the **text path**, "no name but amount" does not pay directly: it confirms
> the matched client (the amount is the anchor, but identity is not corroborated).
> **Image/PDF** keeps the historical staging/review flow.

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

## Text-only vouchers

A payment can be reported as plain text, without a receipt image/PDF. The entry
point is `processVoucherText` (`src/lib/ai/voucher-pipeline.ts`). There are two
paths depending on whether the message carries an amount.

### With amount — the amount is the anchor

Examples: `"me pagaron 422000 en efectivo"`, `"Martu pagó 422000"`,
`"Ale pagó 200000 en transferencia"`.

- `engine.ts` (`isVoucherText`) accepts `amount > 0` + method **without a name**
  (`hasVoucherAnchor`). The name is no longer required.
- The pipeline calls `runVoucherDryRun`:
  1. **Phase 1** searches by exact amount, no name → strongest signal.
  2. **Phase 3** reinforces/disambiguates by name.
  3. **Phase 5** (when the amount is not exact) shows nearby invoices.
- Confirmation rule (`processVoucherText`):
  | Case | Action |
  |------|--------|
  | 1 invoice + **strong** name + cash | pay directly |
  | 1 invoice + **weak** name (score < 0.5) | Confirm/Cancel |
  | 1 invoice + **no name** | Confirm/Cancel showing the client |
  | 1 invoice + transfer | Confirm/Cancel |
  | 2+ invoices / sum | A/B/C (or sum confirmation) |
  | 0 invoices | `no_match` + `voucher_awaiting_match` (ask for the exact name) |
- Partial payments: the confirmation shows the balance and the remaining amount;
  the pending keeps the partial amount and the method.

### Without amount — the name rules (with fuzzy fallback)

Examples: `"Martu pagó en efectivo"`, `"Ale pagó en transferencia a Jorge"`.

- `processVoucherSinMonto` searches by name with `selectNameCandidates`
  (`isNameMatch`: backend score **or** local prefix/token match).
- **Strong name** (`score >= 0.5`) + cash → pay directly.
- **Weak name** (`score < 0.5` but "Ale" → "Ale Casagrande") → confirm.
- **Transfer** → always confirm.
- **No exact/local match** → fuzzy:
  1. `findClientMatchesFuzzy(name)` (`src/lib/facbal/client.ts`) computes
     **Jaro-Winkler** over all clients (`src/lib/text/similarity.ts`), top 8
     with `minScore 0.8`.
  2. Each suggested client is crossed with its **pending invoices**
     (`matchVoucherByName` in parallel, score >= 0.5).
  3. Result: 1 invoice → confirm; 2+ → A/B/C; 0 → `voucher_awaiting_match` and
     ask for the amount or the full name.
- **Golden rule:** fuzzy only **suggests**, never pays on its own. "Martu" scores
  higher for Marta (0.92) than for Martina (0.874); the pending invoice +
  confirmation decide.

### Confirmation before paying

When the match is weak, there is no name, it is a transfer, or it came from
fuzzy:

1. The candidate is saved in `voucher_context.pending` with the original method
   (`mediaMimeType: text/efectivo` or `text/transferencia`).
2. **Confirm / Cancel** buttons are sent (`askTransferConfirm`).
3. Confirm → `processVoucherMessage` registers the payment with the stored method.
4. Cancel → nothing is registered and the pending is cleared.

### Follow-up `voucher_awaiting_match`

When there is no invoice at all (exact, local, or fuzzy), the state is stored in
**`conversations.voucher_awaiting_match`** (jsonb column separate from
`voucher_context`, TTL **5 minutes**):

```typescript
interface AwaitingClientMatch {
  metodoPago: 'Efectivo' | 'Transferencia'
  monto: number | null
  fecha: string | null
  destName: string | null
  attemptedName: string | null   // "Martu"
  createdAt: number
}
```

Message: *"No encontramos facturas pendientes para Martu. ¿Me pasás el monto del
pago? También podés escribir el nombre completo como figura en el sistema."*

`planTurn` (before clarify/router) consumes the next message:

| Reply | Action |
|-------|--------|
| Pure amount (`422000`, `$422.000`, `422 mil`, `son 422000`) | `run_voucher_text` with `amount` + attempted name |
| Name (`Martina`, `es Martina`, `el cliente es Martina`) | `run_voucher_text` with that name and the stored amount |
| `cancelar` / `no` / `olvidalo` | clear and reply "no payment registered" |
| Strong intent (expense/attendance/order) or anything else | clear and continue normal flow |

**Lifecycle:** saved before sending the message; read only if `createdAt` < 5 min
(`VOUCHER_AWAITING_MATCH_TTL_MS`); cleared when a new voucher arrives
(`processVoucherText` / `processVoucherMessage`), via `clear_voucher_awaiting`,
and via the reset `jesusdanielllavesecreta`.

**Parser guards:** "gasté 5000" is not taken as an amount (expense/payment verbs),
dates (`13/10`) and names with digits are rejected, and a strong intent is never
hijacked.

### Examples

| Message | Result |
|---------|--------|
| `me pagaron 422000 en efectivo` | Phase 1 → F-10975 Martina → confirm client → pay |
| `Martu pagó en efectivo` | A/B → "Me pagó" → fuzzy → "¿Es Martina — F-10975 — $422.000?" → pay |
| `Martu pagó 422000 en efectivo` | A/B → "Me pagó" → exact amount + weak name → confirm → pay |
| `Ale pago en efectivo` | A/B → "Me pagó" → weak name ("Ale" → "Ale Casagrande") → confirm → pay |
| `Martu` without fuzzy | ask amount → `422000` → amount path → confirm → pay |
| `Martu` then `Martina` | search "Martina" (strong) → pay/confirm transfer |

> The A/B gate for the **bare payment form** (`"Ale pago en efectivo"`) is still
> active: it was not relaxed. After the tap, the weak name is confirmed. Removing
> it would require changing `classifyPaymentIntent`/`detectAmbiguity` and their
> tests (product decision pending).

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
voucher context for that conversation (pending items + pending texts +
`voucher_awaiting_match`).

## Key Files

| File | Purpose |
|------|---------|
| `src/lib/ai/voucher-pipeline.ts` | Main pipeline (5 matching phases + inline decision + queue + text-only path) |
| `src/lib/ai/voucher-extraction.ts` | AI extraction from receipt images/PDFs |
| `src/lib/ai/voucher-matching.ts` | Tolerance, sum matching, `isNameMatch` / `isStrongNameMatch` / `selectNameCandidates` |
| `src/lib/ai/voucher-context.ts` | Multi-turn context storage (pending items + `awaitingMatch`) |
| `src/lib/text/similarity.ts` | Jaro-Winkler for fuzzy client suggestions |
| `src/lib/facbal/client.ts` | FacBal API client (invoices, payments, `matchVoucherByName`, `findClientMatchesFuzzy`) |
| `src/app/api/whatsapp/webhook/route.ts` | WhatsApp webhook — dispatches to pipeline |
| `src/app/(dashboard)/voucher-debug/page.tsx` | Admin debug UI for pipeline tracing |
| `supabase/migrations/055_voucher_awaiting_match.sql` | `conversations.voucher_awaiting_match` column |

## Key Constants

| Constant | Value | Location |
|----------|-------|----------|
| `NAME_MATCH_THRESHOLD` | 0.5 | `voucher-matching.ts:3` (strong score; local match < 0.5 is confirmed) |
| `VOUCHER_AWAITING_MATCH_TTL_MS` | 300,000 (5 min) | `voucher-context.ts` |
| `MEDIA_TIMEOUT_MS` | 15,000 | `voucher-pipeline.ts:14` |
| `PENDING_TEXT_TTL_MS` | 60,000 | `voucher-context.ts:24` |
