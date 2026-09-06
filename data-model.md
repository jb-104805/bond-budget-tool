# Budget Tool — Data Model

Conceptual/logical schema, intentionally stack-agnostic (no engine chosen yet — see §48 of the spec, deferred). Types below are generic (string, decimal, date, enum) rather than tied to a specific database.

This document assumes the conceptual spec and all decisions resolved in design discussion on 2026-09-04 (see memory: `project_budget_tool.md`). Where I made a modeling call that wasn't explicitly discussed, it's flagged in **Assumptions to confirm** at the end — please review those specifically.

---

## Design principles carried into this schema

- **Derived values are never stored.** Spent, Remaining, % Spent, and category/Unallocated running balances are always computed live from transactions and disposition records — never cached columns. This is required by the spec (§21/§35: recategorizing a transaction must change historical totals) and serves auditability (§36).
- **Real money movement vs. budget-internal decisions are different tables.** A bank transfer (checking → savings) is a `Transaction`. A budget decision to cover a deficit from another category is a `Disposition` — no real money moves, it's bookkeeping. Conflating these would blur exactly the distinction the spec insists on in §15/§19.
- **Unallocated and Exited are not rows in the `Category` table.** Per your explicit correction, they're a state and a disposition, respectively — not budgetable, spendable categories. They may be referenced as *targets* of a `Disposition`, but they never appear in `Category`.
- **Income categories (My/Wife's/Other Income) are not rows in the `Category` table either**, for the same reason — they don't allocate, roll over, or have spending. They're a small enum used only on income-type transactions.
- **History is append-only.** Recurring rule changes (allocations, planned income) create new dated versions rather than overwriting the old amount, per §10.

---

## Entities

### `CategoryGroup`
Organizational only — no financial logic (§7).

| Field | Type | Notes |
|---|---|---|
| id | id | |
| name | string | e.g. "Household", "Living", "Discretionary" |
| sort_order | int | display order |

### `Category`
The real budgeting unit. Includes the one special Savings Transfer category (§16), flagged rather than split into a separate table, since it's a category with extra behavior, not a different kind of thing.

| Field | Type | Notes |
|---|---|---|
| id | id | |
| group_id | FK → CategoryGroup | |
| name | string | |
| rollover_behavior | enum: `ROLLOVER`, `RESET` | governs **positive** balance treatment only (§14) |
| reset_default_disposition_type | enum: `CATEGORY`, `UNALLOCATED`, `EXITED`, nullable | only meaningful when `rollover_behavior = RESET`; per-category configurable default (your decision) |
| reset_default_disposition_category_id | FK → Category, nullable | used only when the above type is `CATEGORY` |
| is_savings_transfer | bool | true for exactly one category |
| designated_savings_account_id | FK → Account, nullable | only set on the Savings Transfer category; used to display the informational real balance (§16) — never used in any calculation |
| active | bool | for retiring a category — see deferred lifecycle question |

### `RecurringAllocationRule`
Versioned recurring allocation for a category (§9/§10). Append-only.

| Field | Type | Notes |
|---|---|---|
| id | id | |
| category_id | FK → Category | |
| amount | decimal | |
| effective_start_month | month | inclusive |
| effective_end_month | month, nullable | inclusive; null = open until superseded |
| created_at | datetime | |

### `CategoryMonth`
The concrete, resolved allocation + opening balance for one category in one month. Generated from `RecurringAllocationRule` but can be manually overridden without rewriting history (§10, §35).

| Field | Type | Notes |
|---|---|---|
| id | id | |
| category_id | FK → Category | |
| month | month | |
| allocation_amount | decimal | the resolved number actually applied this month |
| allocation_source | enum: `RECURRING`, `MANUAL_OVERRIDE` | |
| rule_id | FK → RecurringAllocationRule, nullable | set when source = RECURRING |
| opening_balance | decimal | carried from prior month's closeout (positive rollover, negative carryforward, or 0) |
| note | string, nullable | |

*Spent, Remaining, % Spent are computed:* `Spent = SUM(TransactionCategoryLine.amount WHERE category_id, month)`. `Remaining = allocation_amount + opening_balance − Spent`.

### `PlannedIncomeMonth`
Recurring, effective-dated, exactly like category allocations (your decision). Four fixed fields, purely additive — no per-field actuals tracked.

| Field | Type | Notes |
|---|---|---|
| id | id | |
| income_field | enum: `JASON_PAYCHECK_1`, `JASON_PAYCHECK_2`, `JAMIE_INCOME`, `OTHER` | fixed set, not extensible per-month (a 3rd paycheck is just surplus, not a 5th field) |
| month | month | |
| amount | decimal | |
| source | enum: `RECURRING`, `MANUAL_OVERRIDE` | |
| rule_id | FK → PlannedIncomeRule, nullable | |

*(`PlannedIncomeRule` mirrors `RecurringAllocationRule`'s shape — income_field, amount, effective_start_month, effective_end_month — omitted here to avoid repeating the same table twice.)*

*Planned income total for a month = SUM of the 4 `PlannedIncomeMonth` rows. Actual income for a month = SUM of `Transaction` where `transaction_type = INCOME` and budget_date in that month, aggregate only.*

### `Account`
Lightweight — just enough to know where a transaction came from and to flag special-purpose accounts.

| Field | Type | Notes |
|---|---|---|
| id | id | |
| name | string | |
| account_type | enum: `CHECKING`, `CREDIT_CARD`, `SAVINGS`, `EXTERNAL` | |
| plaid_account_id | string, nullable | null for accounts not connected via Plaid (§18: external funding source doesn't need to be Plaid-linked) |
| is_designated_savings_account | bool | marks the account tied to the Savings Transfer category |
| is_tracked_credit_card | bool | used by (deferred) payment-detection logic |

### `Transaction`
The raw ledger event — one per real (or manually entered) financial event. Handles the pending→posted merge (§20) as one evolving row rather than two transactions.

| Field | Type | Notes |
|---|---|---|
| id | id | |
| account_id | FK → Account | |
| plaid_pending_transaction_id | string, nullable | |
| plaid_posted_transaction_id | string, nullable | populated once Plaid links pending→posted |
| budget_date | date | **pending date**, per your decision — fixed once set, determines budget month even if posting crosses a month boundary |
| posted_date | date, nullable | informational |
| amount | decimal | current/final known amount; updated in place when posted amount differs from pending |
| is_pending | bool | |
| merchant_name | string, nullable | |
| description | string, nullable | |
| transaction_type | enum: `PURCHASE`, `INCOME`, `TRANSFER`, `CREDIT_CARD_PAYMENT`, `EXTERNAL_FUNDING` | see below |
| income_source | enum: `MY_INCOME`, `WIFE_INCOME`, `OTHER_INCOME`, nullable | set only when transaction_type = INCOME; **not** a Category reference |
| categorization_status | enum: `UNCATEGORIZED`, `CATEGORIZED`, `EXCLUDED` | `EXCLUDED` for TRANSFER/CREDIT_CARD_PAYMENT types, which never need category lines |
| created_at / updated_at | datetime | |

**On `transaction_type`:**
- `PURCHASE` — real spending, on any account type (debit or credit card — a purchase is a purchase regardless of how it was paid, per §19). Gets one or more `TransactionCategoryLine` rows.
- `INCOME` — real income; uses `income_source`, no category line.
- `TRANSFER` — generic account-to-account movement (includes the Savings Transfer checking→savings transfer, and a later savings→checking withdrawal for an irregular expense). Excluded from budget; informational only (§15, §16).
- `CREDIT_CARD_PAYMENT` — payment toward a tracked card's balance; excluded from budget, not an expense (§19). Exact detection mechanism deferred (§48).
- `EXTERNAL_FUNDING` — money intentionally brought in from outside to cover a deficit (§18). Unlike TRANSFER, this **does** get a `TransactionCategoryLine` (into the deficit category) but is flagged so it's never counted as ordinary income.

Note: the Savings Transfer *category*'s monthly allocation is tracked as a normal allocation; the actual checking→savings transfer transaction is a `TRANSFER`, informational only, not itself a category line — consistent with §16 ("should not calculate an expected savings balance").

### `TransactionCategoryLine`
Supports splitting (§25). An unsplit transaction has exactly one line equal to the full amount. Lines must sum to `Transaction.amount` (validated at the application layer).

| Field | Type | Notes |
|---|---|---|
| id | id | |
| transaction_id | FK → Transaction | |
| category_id | FK → Category | |
| amount | decimal | |
| note | string, nullable | |

### `MerchantCategoryRule`
Auto-categorization rules (§22/§23). Some merchants (Amazon, Walmart) simply never get a rule — that's fine, they stay manual by omission, no special "do not auto-categorize" flag needed.

| Field | Type | Notes |
|---|---|---|
| id | id | |
| merchant_pattern | string | exact or pattern match — matching mechanism deferred (§48) |
| category_id | FK → Category | |
| active | bool | |
| created_from | enum: `MANUAL`, `LEARNED` | whether learning-from-corrections is ever implemented is deferred (§48) |

### `Disposition`
The budget-internal decision ledger — money moving between categories, Unallocated, and Exited *as a budgeting concept*, not a bank event. This is what makes categories/Unallocated auditable (§36) without ever touching `Transaction`. Covers §14, §17, §33 closeout decisions and mid-flow events like external funding's category-side effect.

| Field | Type | Notes |
|---|---|---|
| id | id | |
| month | month | the month the decision applies to |
| decision_type | enum: `NEGATIVE_COVERAGE`, `RESET_SURPLUS_DISPOSITION`, `INCOME_SURPLUS`, `INCOME_SHORTFALL`, `MANUAL_REALLOCATION` | |
| source_type | enum: `CATEGORY`, `UNALLOCATED`, `EXTERNAL` | |
| source_category_id | FK → Category, nullable | set when source_type = CATEGORY |
| destination_type | enum: `CATEGORY`, `UNALLOCATED`, `EXITED`, `FUTURE_ALLOCATION` | |
| destination_category_id | FK → Category, nullable | set when destination_type = CATEGORY |
| amount | decimal | |
| applied_automatically | bool | true when a default fired silently at closeout without user interaction (your "never block" decision) |
| note | string, nullable | |
| created_at | datetime | |

*Unallocated's running balance is never stored — it's `SUM(Disposition.amount)` where Unallocated is destination, minus `SUM` where it's source, plus any planned-income-never-allocated amounts, all-time or per-month with carry. Same derivation principle as category balances.*

### `PlaidSyncCursor`
Tracks incremental sync progress per Plaid Item/token, so the Edge Function's `/transactions/sync` calls only fetch what's new each run instead of re-pulling full history. Not part of the conceptual spec — pure sync-plumbing.

| Field | Type | Notes |
|---|---|---|
| token_label | string (PK) | matches the Supabase secret name, e.g. `PLAID_TOKEN_CHASE_MAIN` |
| cursor | string, nullable | Plaid's opaque sync cursor; null = do a full initial sync |
| updated_at | datetime | |

### `MonthStatus`
Tracks open/closed state (§3). Not an enforcement lock — closed months remain editable (§35) — just a milestone marker and closeout timestamp.

| Field | Type | Notes |
|---|---|---|
| month | month (PK) | |
| closed_at | datetime, nullable | null = still open |

### `AuditLog`
Generic change history, to satisfy §36 without a bespoke history table per entity.

| Field | Type | Notes |
|---|---|---|
| id | id | |
| entity_type | string | e.g. "TransactionCategoryLine" |
| entity_id | id | |
| field | string | |
| old_value | string | |
| new_value | string | |
| changed_at | datetime | |
| note | string, nullable | |

---

## Assumptions to confirm

These are modeling calls I made by extending principles you already established, but weren't explicitly discussed — flag any that don't match your intent:

1. **Income categories (My/Wife's/Other) are an enum on `Transaction`, not rows in `Category`.** I applied the same reasoning you used for Unallocated/Exited: they don't allocate, roll over, or hold a spendable balance, so they shouldn't live in the same table as Groceries/Gas/Travel.
2. **A generic `AuditLog` table** rather than a bespoke history table per entity (e.g., a `TransactionCategoryLineHistory`). Simpler, but less structured if you ever want rich "show me this category's full history" views — the recurring-rule tables already handle that for allocations specifically, since they're append-only by design.
3. **The Savings Transfer category's real-world transfer is *not* itself a category line** — only the allocation represents the budgeted $200; the actual transfer amount is informational (`TRANSFER` type). This directly follows §16's "should not calculate an expected balance," but means the category's "Spent" for Savings Transfer will typically read $0 (unlike every other category) unless we decide otherwise — worth confirming this is the behavior you want, since it changes how that one row looks on the dashboard.
4. **Category `active` flag** for retiring a category exists as a placeholder field only — the actual lifecycle behavior (what happens to its history, whether it can be reactivated) is left for the deferred technical-design pass, as agreed.

Let me know which of these you want to settle now versus carry forward as open questions.
