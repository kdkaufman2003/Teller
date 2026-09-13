-- Phase 17B: restore RPC-only journal posting (reverts 047 INSERT policy regression).
-- Manual application only. Idempotent.
--
-- Restores migration 025 intent: authenticated clients cannot INSERT journals/lines
-- directly; posting must use SECURITY DEFINER teller_post_journal (042/049).
-- Entity-scoped SELECT policies from 047 are preserved.

-- ---------------------------------------------------------------------------
-- Remove direct authenticated journal INSERT policies (17A-003 / 17B-002)
-- ---------------------------------------------------------------------------

drop policy if exists "teller entity journal entries insert" on public.teller_journal_entries;
drop policy if exists "teller entity journal lines insert" on public.teller_journal_lines;

-- Legacy names (no-op if absent)
drop policy if exists "teller writers insert journal entries" on public.teller_journal_entries;
drop policy if exists "teller writers insert journal lines" on public.teller_journal_lines;

-- ---------------------------------------------------------------------------
-- Probe: journal INSERT policies must be absent; SELECT policies present
-- ---------------------------------------------------------------------------

create or replace function public.teller_phase17b_journal_insert_blocked()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_insert_policies int;
  v_select_policies int;
begin
  select count(*)::int
    into v_insert_policies
  from pg_policies
  where schemaname = 'public'
    and tablename in ('teller_journal_entries', 'teller_journal_lines')
    and cmd = 'INSERT';

  select count(*)::int
    into v_select_policies
  from pg_policies
  where schemaname = 'public'
    and tablename = 'teller_journal_entries'
    and cmd = 'SELECT'
    and policyname = 'teller entity journal entries select';

  return v_insert_policies = 0 and v_select_policies >= 1;
end;
$$;

grant execute on function public.teller_phase17b_journal_insert_blocked() to authenticated, service_role;

comment on function public.teller_phase17b_journal_insert_blocked() is
  'Phase 17B probe: no authenticated journal INSERT RLS policies; entity SELECT intact.';
