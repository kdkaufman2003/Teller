-- Phase 9: Month-end close, adjusting entries, accounting controls
-- Evolves period close to immutable event history; hardens journal posting.

-- ---------------------------------------------------------------------------
-- Evolve teller_period_closes → append-only close/reopen events
-- ---------------------------------------------------------------------------

alter table public.teller_period_closes
  add column if not exists event_type text not null default 'close'
    check (event_type in ('close', 'reopen')),
  add column if not exists effective_closed_through date,
  add column if not exists reopen_reason text not null default '',
  add column if not exists readiness_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists warnings_acknowledged jsonb not null default '[]'::jsonb,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

update public.teller_period_closes
set effective_closed_through = period_end
where effective_closed_through is null and event_type = 'close';

alter table public.teller_period_closes
  drop constraint if exists teller_period_closes_organization_id_period_end_key;

create index if not exists teller_period_closes_org_closed_idx
  on public.teller_period_closes (organization_id, closed_at desc);

create index if not exists teller_period_closes_org_period_idx
  on public.teller_period_closes (organization_id, period_end desc);

-- ---------------------------------------------------------------------------
-- Effective closed-through from latest event snapshot
-- ---------------------------------------------------------------------------

create or replace function public.teller_books_closed_through(p_org uuid)
returns date
language sql
stable
security definer
set search_path = public
as $$
  select effective_closed_through
  from public.teller_period_closes
  where organization_id = p_org
  order by closed_at desc, id desc
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Accounting state watermark (journal + close-relevant metadata mutations)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_accounting_state_versions (
  organization_id uuid primary key references public.teller_organizations (id) on delete cascade,
  accounting_version bigint not null default 0,
  close_state_version bigint not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.teller_accounting_state_versions enable row level security;

create policy "teller members read accounting state versions"
  on public.teller_accounting_state_versions for select
  using (public.teller_is_org_member(organization_id));

insert into public.teller_accounting_state_versions (organization_id, accounting_version, close_state_version)
select o.id, coalesce(j.cnt, 0), 0
from public.teller_organizations o
left join (
  select organization_id, count(*)::bigint as cnt
  from public.teller_journal_entries
  group by organization_id
) j on j.organization_id = o.id
on conflict (organization_id) do update
set accounting_version = excluded.accounting_version;

create or replace function public.teller_org_accounting_lock_key(p_org uuid)
returns bigint
language sql
immutable
as $$
  select ('x' || substr(replace(p_org::text, '-', ''), 1, 16))::bit(64)::bigint;
$$;

create or replace function public.teller_acquire_org_accounting_lock(p_org uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(public.teller_org_accounting_lock_key(p_org));
end;
$$;

create or replace function public.teller_get_accounting_state(p_org uuid)
returns table (accounting_version bigint, close_state_version bigint)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  select coalesce(v.accounting_version, 0), coalesce(v.close_state_version, 0)
  from public.teller_accounting_state_versions v
  where v.organization_id = p_org;
  if not found then
    return query select 0::bigint, 0::bigint;
  end if;
end;
$$;

create or replace function public.teller_increment_accounting_version(p_org uuid)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version bigint;
begin
  insert into public.teller_accounting_state_versions (organization_id, accounting_version, close_state_version)
  values (p_org, 1, 0)
  on conflict (organization_id) do update
  set accounting_version = public.teller_accounting_state_versions.accounting_version + 1,
      updated_at = now()
  returning accounting_version into v_version;
  return v_version;
end;
$$;

create or replace function public.teller_increment_close_state_version(p_org uuid)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version bigint;
begin
  insert into public.teller_accounting_state_versions (organization_id, accounting_version, close_state_version)
  values (p_org, 0, 1)
  on conflict (organization_id) do update
  set close_state_version = public.teller_accounting_state_versions.close_state_version + 1,
      updated_at = now()
  returning close_state_version into v_version;
  return v_version;
end;
$$;

-- Bump accounting version after every economic journal insert (same transaction as posting).
create or replace function public.teller_journal_entries_bump_accounting_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.teller_increment_accounting_version(NEW.organization_id);
  return NEW;
end;
$$;

drop trigger if exists teller_journal_entries_bump_accounting_version on public.teller_journal_entries;
create trigger teller_journal_entries_bump_accounting_version
  after insert on public.teller_journal_entries
  for each row execute function public.teller_journal_entries_bump_accounting_version();

-- Bump close-state version when bank reconciliation or checklist status changes.
create or replace function public.teller_close_state_bump_from_reconciliation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'UPDATE' and OLD.status is distinct from NEW.status
     and NEW.status in ('completed', 'reopened') then
    perform public.teller_increment_close_state_version(NEW.organization_id);
  end if;
  return NEW;
end;
$$;

drop trigger if exists teller_bank_reconciliations_close_state_bump on public.teller_bank_reconciliations;
create trigger teller_bank_reconciliations_close_state_bump
  after update of status on public.teller_bank_reconciliations
  for each row execute function public.teller_close_state_bump_from_reconciliation();

create or replace function public.teller_close_state_bump_from_checklist()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'INSERT'
     or (TG_OP = 'UPDATE' and (OLD.status is distinct from NEW.status or OLD.required is distinct from NEW.required)) then
    perform public.teller_increment_close_state_version(NEW.organization_id);
  end if;
  return NEW;
end;
$$;

-- ---------------------------------------------------------------------------
-- Journal period guard (defense-in-depth — no generic session bypass)
-- ---------------------------------------------------------------------------

create or replace function public.teller_journal_entries_period_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_closed_through date;
begin
  perform public.teller_acquire_org_accounting_lock(NEW.organization_id);

  v_closed_through := public.teller_books_closed_through(NEW.organization_id);
  if v_closed_through is not null and NEW.entry_date <= v_closed_through then
    raise exception 'Accounting period is closed through %', v_closed_through;
  end if;

  return NEW;
end;
$$;

drop trigger if exists teller_journal_entries_period_guard on public.teller_journal_entries;
create trigger teller_journal_entries_period_guard
  before insert on public.teller_journal_entries
  for each row execute function public.teller_journal_entries_period_guard();

-- Remove direct authenticated journal INSERT (posting must use SECURITY DEFINER RPCs)
drop policy if exists "teller writers insert journal entries" on public.teller_journal_entries;
drop policy if exists "teller writers insert journal lines" on public.teller_journal_lines;

-- ---------------------------------------------------------------------------
-- Period close settings (org-level close behavior)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_close_settings (
  organization_id uuid primary key references public.teller_organizations (id) on delete cascade,
  adjustment_approval_required boolean not null default false,
  warnings_require_acknowledgment boolean not null default false,
  required_bank_account_ids uuid[] not null default '{}',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.teller_close_settings enable row level security;

create policy "teller members read close settings"
  on public.teller_close_settings for select
  using (public.teller_is_org_member(organization_id));

create policy "teller admins manage close settings"
  on public.teller_close_settings for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_user_role(organization_id) in ('owner', 'admin')
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_user_role(organization_id) in ('owner', 'admin')
  );

-- ---------------------------------------------------------------------------
-- Period close reviews (workflow — not accounting truth)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_period_close_reviews (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  period_end date not null,
  status text not null default 'open'
    check (status in ('open', 'in_review', 'ready', 'closed')),
  started_at timestamptz,
  started_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users (id) on delete set null,
  readiness_snapshot jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, period_end)
);

create index if not exists teller_period_close_reviews_org_status_idx
  on public.teller_period_close_reviews (organization_id, status);

alter table public.teller_period_close_reviews enable row level security;

create policy "teller members read period close reviews"
  on public.teller_period_close_reviews for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage period close reviews"
  on public.teller_period_close_reviews for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Close checklist items
-- ---------------------------------------------------------------------------

create table if not exists public.teller_close_checklist_items (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  period_end date not null,
  review_id uuid references public.teller_period_close_reviews (id) on delete cascade,
  item_key text not null,
  title text not null,
  description text not null default '',
  source text not null default 'system'
    check (source in ('system', 'custom')),
  required boolean not null default false,
  status text not null default 'pending'
    check (status in ('pending', 'completed', 'skipped')),
  completed_at timestamptz,
  completed_by uuid references auth.users (id) on delete set null,
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, period_end, item_key)
);

create index if not exists teller_close_checklist_org_period_idx
  on public.teller_close_checklist_items (organization_id, period_end);

alter table public.teller_close_checklist_items enable row level security;

create policy "teller members read close checklist"
  on public.teller_close_checklist_items for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage close checklist"
  on public.teller_close_checklist_items for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

drop trigger if exists teller_close_checklist_close_state_bump on public.teller_close_checklist_items;
create trigger teller_close_checklist_close_state_bump
  after insert or update on public.teller_close_checklist_items
  for each row execute function public.teller_close_state_bump_from_checklist();

-- ---------------------------------------------------------------------------
-- Adjusting journal workflow (metadata — canonical GL via teller_post_journal)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_adjusting_journal_entries (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  adjustment_number text not null,
  entry_date date not null,
  adjustment_type text not null default 'general'
    check (adjustment_type in ('general', 'accrual', 'prepaid', 'reclassification', 'correction', 'other')),
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'approved', 'posted', 'reversed')),
  memo text not null default '',
  reference text not null default '',
  lines jsonb not null default '[]'::jsonb,
  prepared_by uuid references auth.users (id) on delete set null,
  submitted_at timestamptz,
  submitted_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  approved_by uuid references auth.users (id) on delete set null,
  posted_at timestamptz,
  posted_by uuid references auth.users (id) on delete set null,
  journal_entry_id uuid references public.teller_journal_entries (id) on delete set null,
  reversal_journal_entry_id uuid references public.teller_journal_entries (id) on delete set null,
  reversal_reason text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, adjustment_number)
);

create index if not exists teller_adjusting_journal_org_status_idx
  on public.teller_adjusting_journal_entries (organization_id, status);

create index if not exists teller_adjusting_journal_org_date_idx
  on public.teller_adjusting_journal_entries (organization_id, entry_date);

alter table public.teller_adjusting_journal_entries enable row level security;

create policy "teller members read adjusting journals"
  on public.teller_adjusting_journal_entries for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage adjusting journals"
  on public.teller_adjusting_journal_entries for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Recurring journal templates + runs (non-GL until posted)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_recurring_journal_templates (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  name text not null,
  memo text not null default '',
  frequency text not null
    check (frequency in ('monthly', 'quarterly', 'annually')),
  start_date date not null,
  end_date date,
  next_run_date date,
  lines jsonb not null default '[]'::jsonb,
  adjustment_type text not null default 'general',
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists teller_recurring_journal_templates_org_idx
  on public.teller_recurring_journal_templates (organization_id, active);

alter table public.teller_recurring_journal_templates enable row level security;

create policy "teller members read recurring journal templates"
  on public.teller_recurring_journal_templates for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage recurring journal templates"
  on public.teller_recurring_journal_templates for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

create table if not exists public.teller_recurring_journal_runs (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  template_id uuid not null references public.teller_recurring_journal_templates (id) on delete cascade,
  period_year integer not null,
  period_month integer not null,
  target_period_end date not null,
  adjusting_journal_entry_id uuid references public.teller_adjusting_journal_entries (id) on delete set null,
  status text not null default 'generated'
    check (status in ('generated', 'posted', 'cancelled')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (template_id, period_year, period_month)
);

create index if not exists teller_recurring_journal_runs_org_idx
  on public.teller_recurring_journal_runs (organization_id);

alter table public.teller_recurring_journal_runs enable row level security;

create policy "teller members read recurring journal runs"
  on public.teller_recurring_journal_runs for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage recurring journal runs"
  on public.teller_recurring_journal_runs for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Performance indexes for close-grade reporting
-- ---------------------------------------------------------------------------

create index if not exists teller_journal_entries_org_entry_date_idx
  on public.teller_journal_entries (organization_id, entry_date);

create index if not exists teller_journal_lines_entry_account_idx
  on public.teller_journal_lines (entry_id, account_id);

-- ---------------------------------------------------------------------------
-- Legacy period close compatibility (Phase 8 direct INSERT/DELETE)
-- ---------------------------------------------------------------------------

create or replace function public.teller_period_closes_legacy_insert_defaults()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(NEW.event_type, '') = '' then
    NEW.event_type := 'close';
  end if;
  if NEW.effective_closed_through is null and NEW.event_type = 'close' then
    NEW.effective_closed_through := NEW.period_end;
  end if;
  return NEW;
end;
$$;

drop trigger if exists teller_period_closes_legacy_insert on public.teller_period_closes;
create trigger teller_period_closes_legacy_insert
  before insert on public.teller_period_closes
  for each row execute function public.teller_period_closes_legacy_insert_defaults();

create or replace function public.teller_period_closes_legacy_delete_to_reopen()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_closed date;
  v_new_effective date;
begin
  if OLD.event_type = 'reopen' then
    raise exception 'Cannot delete reopen history events';
  end if;

  v_current_closed := public.teller_books_closed_through(OLD.organization_id);
  if v_current_closed is null or OLD.period_end <> v_current_closed then
    raise exception 'Only the most recent period close can be reopened';
  end if;

  select max(period_end) into v_new_effective
  from public.teller_period_closes
  where organization_id = OLD.organization_id
    and event_type = 'close'
    and period_end < OLD.period_end;

  insert into public.teller_period_closes (
    organization_id,
    period_end,
    notes,
    closed_by,
    event_type,
    effective_closed_through,
    reopen_reason,
    metadata
  ) values (
    OLD.organization_id,
    OLD.period_end,
    coalesce(OLD.notes, ''),
    coalesce(auth.uid(), OLD.closed_by),
    'reopen',
    v_new_effective,
    'Legacy reopen via DELETE',
    jsonb_build_object('legacyDeleteId', OLD.id, 'reopenedAt', now())
  );

  return null;
end;
$$;

drop trigger if exists teller_period_closes_legacy_delete on public.teller_period_closes;
create trigger teller_period_closes_legacy_delete
  before delete on public.teller_period_closes
  for each row execute function public.teller_period_closes_legacy_delete_to_reopen();

-- ---------------------------------------------------------------------------
-- Atomic period close / reopen RPCs (advisory lock + watermark + immutable events)
-- ---------------------------------------------------------------------------

create or replace function public.teller_close_accounting_period(
  p_organization_id uuid,
  p_period_end date,
  p_notes text default '',
  p_readiness_snapshot jsonb default '{}'::jsonb,
  p_warnings_acknowledged jsonb default '[]'::jsonb,
  p_actor_id uuid default null,
  p_expected_accounting_version bigint default null,
  p_expected_close_state_version bigint default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_closed date;
  v_expected date;
  v_today date := current_date;
  v_event_id uuid;
  v_acct_ver bigint := 0;
  v_close_ver bigint := 0;
  v_incomplete_required integer;
begin
  if auth.uid() is not null
     and public.teller_user_role(p_organization_id) not in ('owner', 'admin') then
    raise exception 'Not authorized to close accounting periods';
  end if;

  perform public.teller_acquire_org_accounting_lock(p_organization_id);

  select coalesce(v.accounting_version, 0), coalesce(v.close_state_version, 0)
  into v_acct_ver, v_close_ver
  from public.teller_accounting_state_versions v
  where v.organization_id = p_organization_id;

  if p_expected_accounting_version is not null then
    if v_acct_ver <> p_expected_accounting_version then
      raise exception 'ACCOUNTING_STATE_CHANGED';
    end if;
  end if;

  if p_expected_close_state_version is not null then
    if v_close_ver <> p_expected_close_state_version then
      raise exception 'ACCOUNTING_STATE_CHANGED';
    end if;
  end if;

  if p_period_end > v_today then
    raise exception 'Cannot close a future period';
  end if;

  v_current_closed := public.teller_books_closed_through(p_organization_id);

  if v_current_closed is not null and p_period_end <= v_current_closed then
    select id into v_event_id
    from public.teller_period_closes
    where organization_id = p_organization_id
      and period_end = p_period_end
      and event_type = 'close'
    order by closed_at desc
    limit 1;
    if v_event_id is not null then
      return v_event_id;
    end if;
    raise exception 'That period is already closed';
  end if;

  if v_current_closed is null then
    v_expected := (date_trunc('month', v_today)::date - interval '1 day')::date;
  else
    v_expected := (date_trunc('month', v_current_closed + interval '1 day') + interval '1 month - 1 day')::date;
  end if;

  if p_period_end <> v_expected then
    raise exception 'Close periods in order. Next period to close ends %.', v_expected;
  end if;

  select count(*) into v_incomplete_required
  from public.teller_close_checklist_items
  where organization_id = p_organization_id
    and period_end = p_period_end
    and required = true
    and status <> 'completed';

  if v_incomplete_required > 0 then
    raise exception 'Required checklist items incomplete (% remaining)', v_incomplete_required;
  end if;

  insert into public.teller_period_closes (
    organization_id,
    period_end,
    notes,
    closed_by,
    event_type,
    effective_closed_through,
    readiness_snapshot,
    warnings_acknowledged,
    metadata
  ) values (
    p_organization_id,
    p_period_end,
    coalesce(p_notes, ''),
    coalesce(p_actor_id, auth.uid()),
    'close',
    p_period_end,
    coalesce(p_readiness_snapshot, '{}'::jsonb),
    coalesce(p_warnings_acknowledged, '[]'::jsonb),
    jsonb_build_object(
      'closedAt', now(),
      'accountingVersion', v_acct_ver,
      'closeStateVersion', v_close_ver
    )
  )
  returning id into v_event_id;

  update public.teller_period_close_reviews
  set status = 'closed', updated_at = now()
  where organization_id = p_organization_id
    and period_end = p_period_end;

  return v_event_id;
end;
$$;

create or replace function public.teller_reopen_accounting_period(
  p_organization_id uuid,
  p_period_end date,
  p_reason text,
  p_actor_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_closed date;
  v_new_effective date;
  v_event_id uuid;
begin
  if auth.uid() is not null
     and public.teller_user_role(p_organization_id) not in ('owner', 'admin') then
    raise exception 'Not authorized to reopen accounting periods';
  end if;

  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Reopen reason is required';
  end if;

  perform public.teller_acquire_org_accounting_lock(p_organization_id);

  v_current_closed := public.teller_books_closed_through(p_organization_id);
  if v_current_closed is null or p_period_end <> v_current_closed then
    raise exception 'Only the most recent closed period can be reopened';
  end if;

  select max(period_end) into v_new_effective
  from public.teller_period_closes
  where organization_id = p_organization_id
    and event_type = 'close'
    and period_end < p_period_end;

  insert into public.teller_period_closes (
    organization_id,
    period_end,
    notes,
    closed_by,
    event_type,
    effective_closed_through,
    reopen_reason,
    metadata
  ) values (
    p_organization_id,
    p_period_end,
    coalesce(trim(p_reason), ''),
    coalesce(p_actor_id, auth.uid()),
    'reopen',
    v_new_effective,
    coalesce(trim(p_reason), ''),
    jsonb_build_object('reopenedAt', now())
  )
  returning id into v_event_id;

  update public.teller_period_close_reviews
  set status = 'open', updated_at = now()
  where organization_id = p_organization_id
    and period_end = p_period_end;

  return v_event_id;
end;
$$;

grant execute on function public.teller_close_accounting_period(uuid, date, text, jsonb, jsonb, uuid, bigint, bigint)
  to authenticated, service_role;
grant execute on function public.teller_reopen_accounting_period(uuid, date, text, uuid)
  to authenticated, service_role;
grant execute on function public.teller_get_accounting_state(uuid)
  to authenticated, service_role;
grant execute on function public.teller_acquire_org_accounting_lock(uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- teller_post_journal — unchanged signature; period guard also on trigger
-- ---------------------------------------------------------------------------

create or replace function public.teller_post_journal(
  p_organization_id uuid,
  p_entry_date date,
  p_memo text,
  p_source_kind text,
  p_source_id uuid,
  p_reverses_entry_id uuid,
  p_lines jsonb
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_entry_id uuid;
  v_line jsonb;
  v_debit numeric(14, 2);
  v_credit numeric(14, 2);
  v_total_debit numeric(14, 2) := 0;
  v_total_credit numeric(14, 2) := 0;
  v_closed_through date;
begin
  if auth.uid() is not null
     and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to post journal entries';
  end if;

  perform public.teller_acquire_org_accounting_lock(p_organization_id);

  v_closed_through := public.teller_books_closed_through(p_organization_id);
  if v_closed_through is not null and p_entry_date <= v_closed_through then
    raise exception 'Accounting period is closed through %', v_closed_through;
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Journal entry requires at least one line';
  end if;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_debit := coalesce((v_line->>'debit')::numeric, 0);
    v_credit := coalesce((v_line->>'credit')::numeric, 0);
    v_total_debit := v_total_debit + v_debit;
    v_total_credit := v_total_credit + v_credit;
  end loop;

  if abs(v_total_debit - v_total_credit) > 0.009 then
    raise exception 'Journal entry is unbalanced: debit % vs credit %', v_total_debit, v_total_credit;
  end if;

  insert into public.teller_journal_entries (
    organization_id,
    entry_date,
    memo,
    source_kind,
    source_id,
    reverses_entry_id
  ) values (
    p_organization_id,
    p_entry_date,
    coalesce(p_memo, ''),
    p_source_kind,
    p_source_id,
    p_reverses_entry_id
  )
  returning id into v_entry_id;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    insert into public.teller_journal_lines (
      entry_id,
      account_id,
      debit,
      credit,
      party_id,
      job_id,
      job_cost_category_id,
      cost_classification,
      fixed_asset_id,
      memo
    ) values (
      v_entry_id,
      (v_line->>'account_id')::uuid,
      coalesce((v_line->>'debit')::numeric, 0),
      coalesce((v_line->>'credit')::numeric, 0),
      nullif(v_line->>'party_id', '')::uuid,
      nullif(v_line->>'job_id', '')::uuid,
      nullif(v_line->>'job_cost_category_id', '')::uuid,
      coalesce(nullif(v_line->>'cost_classification', ''), ''),
      nullif(v_line->>'fixed_asset_id', '')::uuid,
      coalesce(v_line->>'memo', '')
    );
  end loop;

  return v_entry_id;
end;
$$;

grant execute on function public.teller_post_journal(uuid, date, text, text, uuid, uuid, jsonb)
  to authenticated, service_role;
