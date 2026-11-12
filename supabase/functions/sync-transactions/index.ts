// Bond Budget — Plaid transaction sync (Supabase Edge Function, Deno/TypeScript)
//
// Pulls new / changed / removed transactions for every linked bank (Plaid
// /transactions/sync, cursor-based) into the `transactions` table.
//
// Who may call it:
//   - the app, with a signed-in user's session (sync on app open), or
//   - the scheduled GitHub Action, with the `x-cron-secret` header.
// Anyone else gets 401.
//
// Rules (deliberately dumb — no categorizing, no auto-excluding):
//   - Only transactions dated on/after app_settings.import_start_date are kept.
//   - Amounts are stored with the app's sign: + money in, - money out
//     (Plaid uses the opposite, so we flip it here and only here).
//   - Pending rows can't be assigned. When the posted version arrives
//     (linked by Plaid's pending_transaction_id) the pending row is deleted
//     and the posted row takes its place — no duplicates.
//   - If the bank changes the amount of an already-assigned transaction,
//     its envelope assignment is cleared and it returns to the inbox flagged
//     "Amount changed by bank" (so envelope math never silently drifts).
//   - If the bank removes an assigned transaction, it is kept and flagged
//     "Removed by bank" for you to decide; unassigned/excluded ones are deleted.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const PLAID_CLIENT_ID = Deno.env.get('PLAID_CLIENT_ID')!
const PLAID_SECRET = Deno.env.get('PLAID_SECRET')!
const PLAID_BASE_URL = 'https://production.plaid.com'
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? ''

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

const TOKEN_LABELS = [
  'PLAID_TOKEN_COSTCO',
  'PLAID_TOKEN_CHASE_MAIN',
  'PLAID_TOKEN_CHASE_JAMIE_CARDS',
  'PLAID_TOKEN_AMEX_JASON',
  'PLAID_TOKEN_AMEX_JAMIE',
]

// The app syncs on open; skip if a sync finished this recently (both phones
// opening at once shouldn't hit Plaid twice).
const APP_MIN_INTERVAL_MS = 5 * 60 * 1000

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function must<T>(res: { data: T; error: any }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`)
  return res.data
}

async function plaidFetch(path: string, body: Record<string, unknown>) {
  const resp = await fetch(`${PLAID_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: PLAID_CLIENT_ID, secret: PLAID_SECRET, ...body }),
  })
  const json = await resp.json()
  if (!resp.ok) throw new Error(`Plaid ${path} failed: ${json.error_code ?? ''} ${json.error_message ?? JSON.stringify(json)}`)
  return json
}

type Existing = { id: number; plaid_transaction_id: string; amount: number; status: string }

async function fetchExisting(plaidIds: string[]): Promise<Map<string, Existing>> {
  const map = new Map<string, Existing>()
  // Chunked so the request URL stays short on a big first sync.
  for (const part of chunk([...new Set(plaidIds)], 150)) {
    const rows = must(
      await supabase.from('transactions').select('id, plaid_transaction_id, amount, status').in('plaid_transaction_id', part),
      'lookup existing',
    ) as Existing[]
    for (const r of rows) map.set(r.plaid_transaction_id, r)
  }
  return map
}

async function syncOneToken(label: string, accessToken: string, accountIdByPlaidId: Map<string, number>, startDate: string) {
  const cursorRow = must(
    await supabase.from('plaid_sync_cursor').select('cursor').eq('token_label', label).maybeSingle(),
    'read cursor',
  ) as { cursor: string | null } | null
  let cursor: string | null = cursorRow?.cursor ?? null

  let added: any[] = [], modified: any[] = [], removed: any[] = []
  let hasMore = true
  while (hasMore) {
    const page = await plaidFetch('/transactions/sync', { access_token: accessToken, cursor: cursor ?? undefined, count: 500 })
    added = added.concat(page.added)
    modified = modified.concat(page.modified)
    removed = removed.concat(page.removed)
    hasMore = page.has_more
    cursor = page.next_cursor
  }

  // Keep only tracked accounts and dates on/after the import start.
  const incoming = [...added, ...modified].filter((tx) => {
    if (!accountIdByPlaidId.has(tx.account_id)) return false
    const d: string = tx.authorized_date ?? tx.date
    return d >= startDate
  })

  // Pending ids that a posted transaction in this batch replaces.
  const replacedPendingIds = new Set<string>(incoming.filter((tx) => !tx.pending && tx.pending_transaction_id).map((tx) => tx.pending_transaction_id))
  const rowsIn = incoming.filter((tx) => !replacedPendingIds.has(tx.transaction_id))

  const removedIds = removed.map((r) => r.transaction_id as string)
  const existing = await fetchExisting([...rowsIn.map((tx) => tx.transaction_id), ...replacedPendingIds, ...removedIds])

  const toInsert: any[] = []
  const toUpdate: { id: number; fields: any; clearAllocations: boolean }[] = []

  for (const tx of rowsIn) {
    const fields = {
      plaid_transaction_id: tx.transaction_id,
      pending_transaction_id: tx.pending ? null : (tx.pending_transaction_id ?? null),
      account_id: accountIdByPlaidId.get(tx.account_id),
      txn_date: tx.authorized_date ?? tx.date,
      posted_date: tx.pending ? null : tx.date,
      name: tx.name ?? null,
      merchant_name: tx.merchant_name ?? tx.name ?? null,
      amount: Math.round(-tx.amount * 100) / 100,
      pending: !!tx.pending,
      updated_at: new Date().toISOString(),
    }
    const row = existing.get(tx.transaction_id)
    if (!row) {
      toInsert.push(fields)
    } else if (row.status === 'assigned' && Number(row.amount) !== fields.amount) {
      toUpdate.push({ id: row.id, fields: { ...fields, status: 'unassigned', attention: 'Amount changed by bank' }, clearAllocations: true })
    } else {
      toUpdate.push({ id: row.id, fields, clearAllocations: false })
    }
  }

  // Pending rows replaced by their posted version: delete (pending rows can't hold allocations).
  const deleteIds: number[] = []
  for (const pid of replacedPendingIds) {
    const row = existing.get(pid)
    if (row) deleteIds.push(row.id)
  }

  // Removed by the bank.
  const flagRemovedIds: number[] = []
  for (const rid of removedIds) {
    if (replacedPendingIds.has(rid)) continue
    const row = existing.get(rid)
    if (!row) continue
    if (row.status === 'assigned') flagRemovedIds.push(row.id)
    else deleteIds.push(row.id)
  }

  // Delete first so a replaced pending row never sits next to its posted row.
  for (const part of chunk(deleteIds, 150)) must(await supabase.from('transactions').delete().in('id', part), 'delete')
  for (const part of chunk(toInsert, 200)) must(await supabase.from('transactions').insert(part), 'insert')
  for (const u of toUpdate) {
    if (u.clearAllocations) must(await supabase.from('allocations').delete().eq('transaction_id', u.id), 'clear allocations')
    must(await supabase.from('transactions').update(u.fields).eq('id', u.id), 'update')
  }
  for (const part of chunk(flagRemovedIds, 150)) {
    must(await supabase.from('transactions').update({ attention: 'Removed by bank', updated_at: new Date().toISOString() }).in('id', part), 'flag removed')
  }

  // Cursor saved last: if anything above failed, the next run re-reads the same changes.
  must(
    await supabase.from('plaid_sync_cursor').upsert({ token_label: label, cursor, updated_at: new Date().toISOString() }, { onConflict: 'token_label' }),
    'save cursor',
  )

  return { inserted: toInsert.length, updated: toUpdate.length, deleted: deleteIds.length, flagged: flagRemovedIds.length }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  // --- who is calling? ---
  let trigger = ''
  if (CRON_SECRET && req.headers.get('x-cron-secret') === CRON_SECRET) {
    trigger = 'schedule'
  } else {
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    const { data, error } = jwt ? await supabase.auth.getUser(jwt) : { data: null, error: true }
    if (error || !data?.user) return reply({ error: 'Not signed in' }, 401)
    trigger = 'app'
  }

  // --- throttle automatic app-open syncs (a tap on the Sync button sends force) ---
  let force = false
  try { force = !!(await req.json())?.force } catch { /* no body */ }
  if (trigger === 'app' && !force) {
    const { data: last } = await supabase
      .from('sync_runs').select('started_at').eq('ok', true).order('started_at', { ascending: false }).limit(1).maybeSingle()
    if (last && Date.now() - new Date(last.started_at).getTime() < APP_MIN_INTERVAL_MS) {
      return reply({ skipped: 'synced recently', last: last.started_at })
    }
  }

  const run = must(await supabase.from('sync_runs').insert({ trigger }).select('id').single(), 'start run') as { id: number }
  const results: Record<string, unknown> = {}
  let ok = true

  try {
    const settings = must(await supabase.from('app_settings').select('import_start_date').eq('id', 1).single(), 'settings') as { import_start_date: string }
    const accounts = must(await supabase.from('accounts').select('id, plaid_account_id'), 'accounts') as { id: number; plaid_account_id: string }[]
    const accountIdByPlaidId = new Map(accounts.filter((a) => a.plaid_account_id).map((a) => [a.plaid_account_id, a.id]))

    for (const label of TOKEN_LABELS) {
      const accessToken = Deno.env.get(label)
      if (!accessToken) {
        results[label] = { error: 'secret not set' }
        ok = false
        continue
      }
      try {
        results[label] = await syncOneToken(label, accessToken, accountIdByPlaidId, settings.import_start_date)
      } catch (err) {
        results[label] = { error: String(err) }
        ok = false
      }
    }
  } catch (err) {
    results.error = String(err)
    ok = false
  }

  await supabase.from('sync_runs').update({ finished_at: new Date().toISOString(), ok, result: results }).eq('id', run.id)
  return reply({ ok, results }, ok ? 200 : 207)
})
