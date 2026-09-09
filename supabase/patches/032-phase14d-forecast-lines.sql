-- Phase 14D manual patch — forecast lines, assumptions, guards, publish/clone RPCs.
-- Apply after migration 032. Does NOT modify teller_post_journal.

-- ---------------------------------------------------------------------------
-- Forecast version columns for lifecycle / lineage
-- ---------------------------------------------------------------------------

alter table public.teller_forecast_versions
  add column if not exists label text not null default '',
  add column if not exists baseline_kind text not null default 'blank'
    check (baseline_kind in ('blank', 'budget', 'prior_forecast')),
  add column if not exists source_budget_version_id uuid references public.teller_budget_versions (id),
  add column if not exists source_forecast_version_id uuid references public.teller_forecast_versions (id),
  add column if not exists published_by uuid references auth.users (id),
  add column if not exists created_by uuid references auth.users (id);

create index if not exists teller_forecast_versions_org_published_idx
  on public.teller_forecast_versions (organization_id, published_at desc nulls last);

-- ---------------------------------------------------------------------------
-- Forecast lines (account × month)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_forecast_lines (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  forecast_version_id uuid not null references public.teller_forecast_versions (id) on delete cascade,
  account_id uuid not null references public.teller_accounts (id),
  period_month date not null,
  amount numeric(14, 2) not null default 0,
  source_kind text not null default 'manual'
    check (source_kind in ('manual', 'budget', 'clone', 'actual', 'assumption')),
  source_id text,
  notes text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (forecast_version_id, account_id, period_month)
);

create index if not exists teller_forecast_lines_version_period_idx
  on public.teller_forecast_lines (forecast_version_id, period_month, account_id);

create index if not exists teller_forecast_lines_org_version_idx
  on public.teller_forecast_lines (organization_id, forecast_version_id);

alter table public.teller_forecast_lines enable row level security;

create policy "teller members read forecast lines"
  on public.teller_forecast_lines for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage forecast lines"
  on public.teller_forecast_lines for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Forecast assumptions
-- ---------------------------------------------------------------------------

create table if not exists public.teller_forecast_assumptions (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  forecast_version_id uuid not null references public.teller_forecast_versions (id) on delete cascade,
  name text not null,
  description text not null default '',
  assumption_kind text not null default 'other'
    check (assumption_kind in (
      'revenue_growth', 'labor_cost', 'material_inflation', 'rent_increase',
      'seasonality', 'other', 'general'
    )),
  value_type text not null default 'text'
    check (value_type in ('percentage', 'currency', 'text')),
  value_numeric numeric(14, 4),
  value_text text,
  effective_start_month date,
  effective_end_month date,
  target_account_id uuid references public.teller_accounts (id),
  parameters jsonb not null default '{}'::jsonb,
  priority int not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists teller_forecast_assumptions_version_idx
  on public.teller_forecast_assumptions (forecast_version_id, priority);

alter table public.teller_forecast_assumptions enable row level security;

create policy "teller members read forecast assumptions"
  on public.teller_forecast_assumptions for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage forecast assumptions"
  on public.teller_forecast_assumptions for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Cross-org integrity guards
-- ---------------------------------------------------------------------------

create or replace function public.teller_guard_forecast_version_org()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_forecast_org uuid;
begin
  select organization_id into v_forecast_org
  from public.teller_forecasts
  where id = new.forecast_id;

  if v_forecast_org is null then
    raise exception 'Forecast not found';
  end if;

  if new.organization_id is distinct from v_forecast_org then
    raise exception 'Forecast version organization must match forecast organization';
  end if;

  return new;
end;
$$;

drop trigger if exists teller_forecast_versions_org_guard on public.teller_forecast_versions;
create trigger teller_forecast_versions_org_guard
  before insert or update on public.teller_forecast_versions
  for each row execute function public.teller_guard_forecast_version_org();

create or replace function public.teller_guard_forecast_line_org()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_version_org uuid;
  v_account_org uuid;
begin
  select organization_id into v_version_org
  from public.teller_forecast_versions
  where id = coalesce(new.forecast_version_id, old.forecast_version_id);

  if v_version_org is null then
    raise exception 'Forecast version not found';
  end if;

  if coalesce(new.organization_id, old.organization_id) is distinct from v_version_org then
    raise exception 'Forecast line organization must match version organization';
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    select organization_id into v_account_org
    from public.teller_accounts
    where id = new.account_id;

    if v_account_org is null then
      raise exception 'GL account not found';
    end if;

    if v_account_org is distinct from new.organization_id then
      raise exception 'GL account must belong to the same organization';
    end if;
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists teller_forecast_lines_org_guard on public.teller_forecast_lines;
create trigger teller_forecast_lines_org_guard
  before insert or update or delete on public.teller_forecast_lines
  for each row execute function public.teller_guard_forecast_line_org();

create or replace function public.teller_guard_forecast_assumption_org()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_version_org uuid;
  v_account_org uuid;
begin
  select organization_id into v_version_org
  from public.teller_forecast_versions
  where id = coalesce(new.forecast_version_id, old.forecast_version_id);

  if v_version_org is null then
    raise exception 'Forecast version not found';
  end if;

  if coalesce(new.organization_id, old.organization_id) is distinct from v_version_org then
    raise exception 'Forecast assumption organization must match version organization';
  end if;

  if tg_op in ('INSERT', 'UPDATE') and new.target_account_id is not null then
    select organization_id into v_account_org
    from public.teller_accounts
    where id = new.target_account_id;

    if v_account_org is distinct from new.organization_id then
      raise exception 'Target account must belong to the same organization';
    end if;
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists teller_forecast_assumptions_org_guard on public.teller_forecast_assumptions;
create trigger teller_forecast_assumptions_org_guard
  before insert or update or delete on public.teller_forecast_assumptions
  for each row execute function public.teller_guard_forecast_assumption_org();

-- ---------------------------------------------------------------------------
-- Published / archived immutability on forecast lines and assumptions
-- ---------------------------------------------------------------------------

create or replace function public.teller_guard_forecast_line_editable()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_immutable boolean;
  v_status text;
begin
  select fv.is_immutable, fv.status into v_immutable, v_status
  from public.teller_forecast_versions fv
  where fv.id = coalesce(new.forecast_version_id, old.forecast_version_id);

  if v_status in ('published', 'archived') or v_immutable then
    raise exception 'Forecast version is not editable (status: %)', v_status;
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists teller_forecast_lines_immutability_guard on public.teller_forecast_lines;
create trigger teller_forecast_lines_immutability_guard
  before insert or update or delete on public.teller_forecast_lines
  for each row execute function public.teller_guard_forecast_line_editable();

create or replace function public.teller_guard_forecast_assumption_editable()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_immutable boolean;
  v_status text;
begin
  select fv.is_immutable, fv.status into v_immutable, v_status
  from public.teller_forecast_versions fv
  where fv.id = coalesce(new.forecast_version_id, old.forecast_version_id);

  if v_status in ('published', 'archived') or v_immutable then
    raise exception 'Forecast version is not editable (status: %)', v_status;
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists teller_forecast_assumptions_immutability_guard on public.teller_forecast_assumptions;
create trigger teller_forecast_assumptions_immutability_guard
  before insert or update or delete on public.teller_forecast_assumptions
  for each row execute function public.teller_guard_forecast_assumption_editable();

-- ---------------------------------------------------------------------------
-- RPC: publish forecast version (immutable snapshot)
-- ---------------------------------------------------------------------------

create or replace function public.teller_atomic_publish_forecast_version(
  p_organization_id uuid,
  p_version_id uuid,
  p_actor_id uuid,
  p_actual_cutoff_month date
)
returns public.teller_forecast_versions
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.teller_forecast_versions;
begin
  if not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to publish forecasts';
  end if;

  select * into v_row
  from public.teller_forecast_versions
  where id = p_version_id
    and organization_id = p_organization_id;

  if not found then
    raise exception 'Forecast version not found';
  end if;

  if v_row.status <> 'draft' then
    raise exception 'Only draft forecast versions can be published';
  end if;

  update public.teller_forecast_versions
  set
    status = 'published',
    published_at = now(),
    published_by = p_actor_id,
    actual_cutoff_month = p_actual_cutoff_month,
    is_immutable = true
  where id = p_version_id
    and organization_id = p_organization_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.teller_atomic_publish_forecast_version(uuid, uuid, uuid, date) from public;
grant execute on function public.teller_atomic_publish_forecast_version(uuid, uuid, uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: clone forecast version + lines + assumptions
-- ---------------------------------------------------------------------------

create or replace function public.teller_atomic_clone_forecast_version(
  p_organization_id uuid,
  p_source_version_id uuid,
  p_actor_id uuid,
  p_label text default ''
)
returns public.teller_forecast_versions
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_source public.teller_forecast_versions;
  v_new public.teller_forecast_versions;
  v_next int;
begin
  if not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to clone forecasts';
  end if;

  select * into v_source
  from public.teller_forecast_versions
  where id = p_source_version_id
    and organization_id = p_organization_id;

  if not found then
    raise exception 'Source forecast version not found';
  end if;

  select coalesce(max(version_number), 0) + 1 into v_next
  from public.teller_forecast_versions
  where forecast_id = v_source.forecast_id;

  insert into public.teller_forecast_versions (
    organization_id,
    forecast_id,
    version_number,
    label,
    status,
    baseline_kind,
    source_budget_version_id,
    source_forecast_version_id,
    actual_cutoff_month,
    is_immutable,
    created_by,
    metadata
  ) values (
    v_source.organization_id,
    v_source.forecast_id,
    v_next,
    coalesce(nullif(trim(p_label), ''), 'Revision ' || v_next::text),
    'draft',
    'prior_forecast',
    v_source.source_budget_version_id,
    v_source.id,
    v_source.actual_cutoff_month,
    false,
    p_actor_id,
    coalesce(v_source.metadata, '{}'::jsonb)
  )
  returning * into v_new;

  insert into public.teller_forecast_lines (
    organization_id,
    forecast_version_id,
    account_id,
    period_month,
    amount,
    source_kind,
    source_id,
    notes,
    metadata
  )
  select
    fl.organization_id,
    v_new.id,
    fl.account_id,
    fl.period_month,
    fl.amount,
    'clone',
    v_source.id::text,
    fl.notes,
    fl.metadata
  from public.teller_forecast_lines fl
  where fl.forecast_version_id = v_source.id
    and fl.organization_id = p_organization_id;

  insert into public.teller_forecast_assumptions (
    organization_id,
    forecast_version_id,
    name,
    description,
    assumption_kind,
    value_type,
    value_numeric,
    value_text,
    effective_start_month,
    effective_end_month,
    target_account_id,
    parameters,
    priority
  )
  select
    fa.organization_id,
    v_new.id,
    fa.name,
    fa.description,
    fa.assumption_kind,
    fa.value_type,
    fa.value_numeric,
    fa.value_text,
    fa.effective_start_month,
    fa.effective_end_month,
    fa.target_account_id,
    fa.parameters,
    fa.priority
  from public.teller_forecast_assumptions fa
  where fa.forecast_version_id = v_source.id
    and fa.organization_id = p_organization_id;

  return v_new;
end;
$$;

revoke all on function public.teller_atomic_clone_forecast_version(uuid, uuid, uuid, text) from public;
grant execute on function public.teller_atomic_clone_forecast_version(uuid, uuid, uuid, text) to authenticated;
