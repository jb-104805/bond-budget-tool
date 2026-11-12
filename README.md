# Bond Budget

A deliberately dumb, phone-first envelope budget for two people sharing one household.
Bank transactions arrive from Plaid into an inbox; you tap each one into an envelope
(or split it, or exclude it) and it leaves the inbox. No rules, no auto-categorizing.

**Live app:** https://jb-104805.github.io/bond-budget-tool/ — open it on each phone,
sign in once with the shared household login, then *Add to Home Screen*.

## How it works

- **Inbox** — unassigned transactions. Pending ones are greyed out and can't be assigned
  until the bank posts them (the posted version replaces the pending one).
  *Show all* lists every transaction for a month with its envelope or "Excluded".
- **Assign** — tap a transaction → tap an envelope. **Split** across envelopes (must add up
  to the penny). **Exclude** removes it from budgeting (paychecks, card payments,
  transfers — your call); excluded is never deleted and can be restored.
- **Income** is just a transaction. Assigning money-in to an envelope adds to it.
- **Envelopes** — name and balance. Balances can go negative (red).
  Totals: grand, rollover, non-rollover (archived envelopes don't count).
- **Refill** (one button, undoable) — rollover envelopes get + their refill amount;
  non-rollover envelopes are set to exactly their refill amount. Nothing happens on a
  calendar; envelopes are oblivious to time.
- **Change balance / Move money** — stored as adjustment records (shown in purple in the
  envelope's history), never by overwriting a number, so every balance is explainable and
  any adjustment can be deleted.
- **Bank changes** — if the bank changes the amount of an assigned transaction it returns
  to the inbox flagged *Amount changed by bank*; if the bank removes an assigned one it's
  kept and flagged *Removed by bank*.

Envelope balance = sum of its transaction allocations + sum of its adjustments
(always computed live, never stored). Amounts: **+ money in, − money out**.

## Pieces

| Piece | Where |
|---|---|
| App (static PWA) | `index.html`, `manifest.webmanifest`, `sw.js`, `icons/` — GitHub Pages |
| Database + login | Supabase project `ldpzpobdhchuervziqrn` (Postgres, Row Level Security: signed-in only) |
| Schema + server functions | `sql/001_envelope_migration.sql` |
| Plaid sync | `supabase/functions/sync-transactions/index.ts` (Supabase Edge Function, Deno/TypeScript) |
| Schedule + backups | private repo `jb-104805/bond-budget-automation` (GitHub Actions) |

Plaid access tokens live only as Supabase Edge Function secrets (`PLAID_TOKEN_*`,
`PLAID_CLIENT_ID`, `PLAID_SECRET`) — never in this repo or the app. They are the same
tokens the Finance Dashboard uses: if a bank disconnects, re-link with
`Bank Account Dashboard\relink_account.bat` (update mode), never a fresh Plaid link.

## Handy SQL (Supabase → SQL editor)

Import start date (transactions before this are ignored):

```sql
update app_settings set import_start_date = '2026-12-01';
```

Try it out on November data first, then start clean on Dec 1:

```sql
-- trial: pull November in (next sync re-reads history)
update app_settings set import_start_date = '2026-11-01';
delete from plaid_sync_cursor;
```

```sql
-- go live: wipe trial activity, keep envelopes and their settings
delete from adjustments;
delete from refills;
delete from transactions;          -- also removes their allocations
update app_settings set import_start_date = '2026-12-01';
delete from plaid_sync_cursor;
```

The old monthly-budget tables were parked in the `old_budget` schema by the migration.
Once you're sure you don't need them: `drop schema old_budget cascade;`
