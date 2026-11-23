-- =====================================================================
-- Bond Budget — permanently delete the old monthly-budget model
-- =====================================================================
-- Run once in the Supabase SQL editor after 001_envelope_migration.sql.
-- PERMANENT: the old categories, monthly allocations, old transactions and
-- their categorizations are deleted. Nightly backups never included them.
-- Runs as one transaction: on any error, nothing is changed.
-- =====================================================================

begin;

do $$
begin
  if to_regclass('public.envelopes') is null then
    raise exception 'The envelope migration (001) has not been run. Nothing changed.';
  end if;
end $$;

-- The old tables (parked here by 001).
drop schema if exists old_budget cascade;

-- Old-model data types that stayed in public. None are used by the envelope app.
-- (account_type is kept: the accounts table uses it.)
drop type if exists public.rollover_behavior;
drop type if exists public.disposition_target_type;
drop type if exists public.allocation_source;
drop type if exists public.income_field;
drop type if exists public.transaction_type;
drop type if exists public.income_source;
drop type if exists public.categorization_status;
drop type if exists public.rule_created_from;
drop type if exists public.decision_type;
drop type if exists public.disposition_source_type;

commit;
