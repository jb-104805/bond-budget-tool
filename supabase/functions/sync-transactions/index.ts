// Budget Tool — Plaid transaction sync
//
// Pulls new/changed/removed transactions from Plaid for each linked account
// (via /transactions/sync, cursor-based) and mirrors them into the `transaction`
// table. Classification here only ever produces PURCHASE, INCOME, TRANSFER, or
// CREDIT_CARD_PAYMENT automatically — EXTERNAL_FUNDING is always a manual
// reclassification a user makes later (Plaid has no signal for it).
//
// Pending→posted merge (spec §20): when Plaid reports a posted transaction
// with a `pending_transaction_id`, we find the existing row by its pending ID
// and update it in place, rather than inserting a second row.
//
// Performance note: a first-ever sync can return hundreds of transactions per
// account. Everything below is batched (a handful of queries per token, not
// one query per transaction) to stay well within the function's time limit.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const PLAID_CLIENT_ID = Deno.env.get('PLAID_CLIENT_ID')!
const PLAID_SECRET = Deno.env.get('PLAID_SECRET')!
const PLAID_BASE_URL = 'https://production.plaid.com'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const TOKEN_LABELS = [
  'PLAID_TOKEN_COSTCO',
  'PLAID_TOKEN_CHASE_MAIN',
  'PLAID_TOKEN_CHASE_JAMIE_CARDS',
  'PLAID_TOKEN_AMEX_JASON',
  'PLAID_TOKEN_AMEX_JAMIE',
]

async function plaidFetch(path: string, body: Record<string, unknown>) {
  const resp = await fetch(`${PLAID_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: PLAID_CLIENT_ID, secret: PLAID_SECRET, ...body }),
  })
  const json = await resp.json()
  if (!resp.ok) throw new Error(`Plaid ${path} failed: ${JSON.stringify(json)}`)
  return json
}

// Plaid's personal_finance_category isn't reliably populated for card-payment
// transactions in practice, so credit-card-payment detection also falls back
// to matching common real-world payment phrasing on the transaction name
// (e.g. "Payment Thank You-Mobile", "ONLINE PAYMENT, THANK YOU", "Payment to
// Chase card ending in 1234") — the exact mechanism spec §19/§48 explicitly
// leaves open for technical-design-time validation. Revisit if false
// positives/negatives show up.
const CARD_PAYMENT_NAME_PATTERN = /payment.*thank you|online payment|mobile payment|payment to .*card|thank you.*payment/i

function classify(plaidTx: any, accountType: string): { transactionType: string; incomeSource: string | null } {
  const detailed: string = plaidTx.personal_finance_category?.detailed ?? ''
  const primary: string = plaidTx.personal_finance_category?.primary ?? ''
  const name: string = plaidTx.name ?? ''

  const looksLikeCardPayment =
    accountType === 'CREDIT_CARD' &&
    (detailed === 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' || primary === 'LOAN_PAYMENTS' || CARD_PAYMENT_NAME_PATTERN.test(name))

  if (looksLikeCardPayment) {
    return { transactionType: 'CREDIT_CARD_PAYMENT', incomeSource: null }
  }
  if (detailed.startsWith('TRANSFER_')) {
    return { transactionType: 'TRANSFER', incomeSource: null }
  }
  if (detailed.startsWith('INCOME_')) {
    return { transactionType: 'INCOME', incomeSource: 'OTHER_INCOME' }
  }
  return { transactionType: 'PURCHASE', incomeSource: null }
}

function buildFields(plaidTx: any, accountId: number, accountType: string) {
  const { transactionType, incomeSource } = classify(plaidTx, accountType)
  const isPending = !!plaidTx.pending
  return {
    account_id: accountId,
    budget_date: plaidTx.date,
    posted_date: isPending ? null : plaidTx.date,
    amount: plaidTx.amount,
    is_pending: isPending,
    merchant_name: plaidTx.merchant_name ?? plaidTx.name ?? null,
    description: plaidTx.name ?? null,
    transaction_type: transactionType,
    income_source: incomeSource,
    categorization_status: transactionType === 'INCOME' ? 'CATEGORIZED' : (transactionType === 'PURCHASE' ? 'UNCATEGORIZED' : 'EXCLUDED'),
    updated_at: new Date().toISOString(),
  }
}

async function syncOneToken(label: string, accessToken: string, accountsByPlaidId: Map<string, { id: number; account_type: string }>) {
  const { data: cursorRow } = await supabase.from('plaid_sync_cursor').select('cursor').eq('token_label', label).maybeSingle()
  let cursor: string | null = cursorRow?.cursor ?? null
  let added: any[] = [], modified: any[] = [], removed: any[] = []
  let hasMore = true

  while (hasMore) {
    const page = await plaidFetch('/transactions/sync', { access_token: accessToken, cursor: cursor ?? undefined })
    added = added.concat(page.added)
    modified = modified.concat(page.modified)
    removed = removed.concat(page.removed)
    hasMore = page.has_more
    cursor = page.next_cursor
  }

  // Only transactions on accounts we actually track.
  const relevant = [...added, ...modified].filter((tx) => accountsByPlaidId.has(tx.account_id))

  // One batch lookup instead of one query per transaction.
  const pendingIds = relevant.map((tx) => tx.pending_transaction_id).filter(Boolean)
  const ownIds = relevant.map((tx) => tx.transaction_id)
  const lookupIds = [...new Set([...pendingIds, ...ownIds])]

  const { data: existingRows } = lookupIds.length
    ? await supabase
        .from('transaction')
        .select('id, plaid_pending_transaction_id, plaid_posted_transaction_id')
        .or(`plaid_pending_transaction_id.in.(${lookupIds.join(',')}),plaid_posted_transaction_id.in.(${lookupIds.join(',')})`)
    : { data: [] as any[] }

  const byPendingId = new Map<string, any>()
  const byPostedId = new Map<string, any>()
  for (const row of existingRows ?? []) {
    if (row.plaid_pending_transaction_id) byPendingId.set(row.plaid_pending_transaction_id, row)
    if (row.plaid_posted_transaction_id) byPostedId.set(row.plaid_posted_transaction_id, row)
  }

  const toInsert: any[] = []
  const toUpdate: { id: number; fields: any }[] = []

  for (const plaidTx of relevant) {
    const account = accountsByPlaidId.get(plaidTx.account_id)!
    const fields = buildFields(plaidTx, account.id, account.account_type)
    const isPending = !!plaidTx.pending

    // Case 1: posted transaction superseding an earlier pending one.
    if (plaidTx.pending_transaction_id && byPendingId.has(plaidTx.pending_transaction_id)) {
      const existing = byPendingId.get(plaidTx.pending_transaction_id)
      toUpdate.push({ id: existing.id, fields: { ...fields, plaid_posted_transaction_id: plaidTx.transaction_id } })
      continue
    }

    // Case 2: already exists under its own transaction_id (a `modified` entry, or a re-seen `added`).
    const existing = isPending ? byPendingId.get(plaidTx.transaction_id) : byPostedId.get(plaidTx.transaction_id)
    if (existing) {
      toUpdate.push({ id: existing.id, fields })
      continue
    }

    // Case 3: genuinely new row.
    toInsert.push({
      ...fields,
      plaid_pending_transaction_id: isPending ? plaidTx.transaction_id : null,
      plaid_posted_transaction_id: isPending ? null : plaidTx.transaction_id,
    })
  }

  if (toInsert.length) await supabase.from('transaction').insert(toInsert)
  await Promise.all(toUpdate.map(({ id, fields }) => supabase.from('transaction').update(fields).eq('id', id)))

  // Removed: batch-delete rows that were never merged forward into a posted version.
  if (removed.length) {
    const removedIds = removed.map((r) => r.transaction_id)
    const { data: removableRows } = await supabase
      .from('transaction')
      .select('id, plaid_pending_transaction_id, plaid_posted_transaction_id')
      .or(`plaid_pending_transaction_id.in.(${removedIds.join(',')}),plaid_posted_transaction_id.in.(${removedIds.join(',')})`)

    const idsToDelete = (removableRows ?? [])
      .filter((row) => {
        const pendingMatched = row.plaid_pending_transaction_id && removedIds.includes(row.plaid_pending_transaction_id)
        const postedMatched = row.plaid_posted_transaction_id && removedIds.includes(row.plaid_posted_transaction_id)
        // A posted-side match is a real removal. A pending-side match only counts
        // if it was never merged forward into a posted row (already-merged rows
        // are left alone — the "removed" here just means the old pending ID is gone).
        if (postedMatched) return true
        if (pendingMatched) return !row.plaid_posted_transaction_id
        return false
      })
      .map((row) => row.id)

    if (idsToDelete.length) await supabase.from('transaction').delete().in('id', idsToDelete)
  }

  await supabase.from('plaid_sync_cursor').upsert({ token_label: label, cursor, updated_at: new Date().toISOString() }, { onConflict: 'token_label' })

  return { added: added.length, modified: modified.length, removed: removed.length, inserted: toInsert.length, updated: toUpdate.length }
}

Deno.serve(async (_req) => {
  const results: Record<string, unknown> = {}

  const { data: accounts } = await supabase.from('account').select('id, plaid_account_id, account_type')
  const accountsByPlaidId = new Map((accounts ?? []).map((a) => [a.plaid_account_id, { id: a.id, account_type: a.account_type }]))

  for (const label of TOKEN_LABELS) {
    const accessToken = Deno.env.get(label)
    if (!accessToken) {
      results[label] = { error: 'secret not set' }
      continue
    }
    try {
      results[label] = await syncOneToken(label, accessToken, accountsByPlaidId)
    } catch (err) {
      results[label] = { error: String(err) }
    }
  }

  return new Response(JSON.stringify(results, null, 2), { headers: { 'Content-Type': 'application/json' } })
})
