-- Phase 17E: audit immutability + operational probe.
-- Manual application only. No data mutation. No audit row deletion.

-- ---------------------------------------------------------------------------
-- Append-only guard — block UPDATE on audit tables (DELETE remains service-role
-- break-glass for demo cleanup; normal users have no UPDATE/DELETE via RLS).
-- ---------------------------------------------------------------------------

create or replace function public.teller_audit_append_only_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'AUDIT_APPEND_ONLY: updates to % are not permitted', tg_table_name
      using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists teller_audit_events_no_update on public.teller_audit_events;
create trigger teller_audit_events_no_update
  before update on public.teller_audit_events
  for each row execute function public.teller_audit_append_only_guard();

drop trigger if exists teller_planning_audit_events_no_update on public.teller_planning_audit_events;
create trigger teller_planning_audit_events_no_update
  before update on public.teller_planning_audit_events
  for each row execute function public.teller_audit_append_only_guard();

drop trigger if exists teller_tax_audit_events_no_update on public.teller_tax_audit_events;
create trigger teller_tax_audit_events_no_update
  before update on public.teller_tax_audit_events
  for each row execute function public.teller_audit_append_only_guard();

revoke update on public.teller_audit_events from authenticated, anon;
revoke update on public.teller_planning_audit_events from authenticated, anon;
revoke update on public.teller_tax_audit_events from authenticated, anon;

-- ---------------------------------------------------------------------------
-- HFAC failed/pending observability index (ops queries; no data change)
-- ---------------------------------------------------------------------------

create index if not exists teller_hfac_webhook_events_status_received_idx
  on public.teller_hfac_webhook_events (processing_status, received_at desc);

grant select on public.teller_hfac_webhook_events to service_role;

-- Operator snapshot (service role / ops tooling; table has RLS, no member policies)
create or replace function public.teller_hfac_webhook_ops_snapshot()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stale timestamptz := now() - interval '24 hours';
begin
  return jsonb_build_object(
    'pending', (select count(*)::int from public.teller_hfac_webhook_events where processing_status = 'pending'),
    'failed', (select count(*)::int from public.teller_hfac_webhook_events where processing_status = 'failed'),
    'processed', (select count(*)::int from public.teller_hfac_webhook_events where processing_status = 'processed'),
    'stale_pending', (
      select count(*)::int from public.teller_hfac_webhook_events
      where processing_status = 'pending' and received_at < v_stale
    )
  );
end;
$$;

grant execute on function public.teller_hfac_webhook_ops_snapshot() to service_role;

-- ---------------------------------------------------------------------------
-- Production verification probe
-- ---------------------------------------------------------------------------

create or replace function public.teller_phase17e_operations_probe()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  return exists (
    select 1 from pg_trigger
    where tgname = 'teller_audit_events_no_update'
      and tgrelid = 'public.teller_audit_events'::regclass
  )
  and exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'teller_hfac_webhook_events_status_received_idx'
  )
  and exists (
    select 1 from pg_proc
    where proname = 'teller_hfac_webhook_ops_snapshot'
  );
end;
$$;

grant execute on function public.teller_phase17e_operations_probe() to authenticated, service_role;
