-- Additive patch if migration 047 was applied before the probe RPC existed.
-- Manual apply only.

create or replace function public.teller_phase16h_controls_applied()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'teller_accounts'
      and policyname = 'teller entity accounts select'
  )
  and exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'teller_documents'
      and policyname = 'teller entity documents select'
  )
  and exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'teller_journal_entries'
      and policyname = 'teller entity journal entries select'
  )
  and exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'teller_payments'
      and policyname = 'teller entity payments select'
  )
  and exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'teller_bank_accounts'
      and policyname = 'teller entity bank accounts select'
  )
  and not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'teller_accounts'
      and policyname = 'teller members read accounts'
  );
$$;

grant execute on function public.teller_phase16h_controls_applied() to authenticated, service_role;
