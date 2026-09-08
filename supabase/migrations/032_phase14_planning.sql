-- Phase 14: Planning foundation — budgets, settings, audit (additive)
-- Local only — operator applies manually. Does NOT modify GL or teller_post_journal.

-- ---------------------------------------------------------------------------
-- Organization planning settings
-- ---------------------------------------------------------------------------

create table if not exists public.teller_planning_settings (
  organization_id uuid primary key references public.teller_organizations (id) on delete cascade,
  default_ar_collection_days int not null default 30 check (default_ar_collection_days >= 0),
  default_ap_payment_days int not null default 15 check (default_ap_payment_days >= 0),
  forecast_horizon_months int not null default 12 check (forecast_horizon_months between 1 and 36),
  cash_planning_grain text not null default 'weekly'
    check (cash_planning_grain in ('weekly', 'monthly')),
  payroll_cadence text not null default 'biweekly'
    check (payroll_cadence in ('weekly', 'biweekly', 'semimonthly', 'monthly')),
  runway_threshold numeric(14, 2) not null default 0,
  party_overrides jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id)
);

alter table public.teller_planning_settings enable row level security;

create policy "teller members read planning settings"
  on public.teller_planning_settings for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage planning settings"
  on public.teller_planning_settings for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Budget header
-- ---------------------------------------------------------------------------

create table if not exists public.teller_budgets (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  name text not null,
  fiscal_year int not null check (fiscal_year between 1900 and 2200),
  budget_type text not null default 'operating'
    check (budget_type in ('operating')),
  currency_code text not null default 'USD',
  status text not null default 'active' check (status in ('active', 'archived')),
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists teller_budgets_org_fy_type_active_idx
  on public.teller_budgets (organization_id, fiscal_year, budget_type)
  where status = 'active';

create index if not exists teller_budgets_org_fy_idx
  on public.teller_budgets (organization_id, fiscal_year);

alter table public.teller_budgets enable row level security;

create policy "teller members read budgets"
  on public.teller_budgets for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage budgets"
  on public.teller_budgets for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Budget versions
-- ---------------------------------------------------------------------------

create table if not exists public.teller_budget_versions (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  budget_id uuid not null references public.teller_budgets (id) on delete cascade,
  version_number int not null check (version_number >= 1),
  label text not null default '',
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'approved', 'locked', 'archived')),
  baseline_kind text not null default 'blank'
    check (baseline_kind in ('blank', 'prior_year_actual', 'prior_version')),
  baseline_version_id uuid references public.teller_budget_versions (id),
  source_version_id uuid references public.teller_budget_versions (id),
  approved_at timestamptz,
  approved_by uuid references auth.users (id),
  locked_at timestamptz,
  notes text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (budget_id, version_number)
);

create index if not exists teller_budget_versions_org_budget_idx
  on public.teller_budget_versions (organization_id, budget_id, status);

alter table public.teller_budget_versions enable row level security;

create policy "teller members read budget versions"
  on public.teller_budget_versions for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage budget versions"
  on public.teller_budget_versions for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Budget lines (account × month)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_budget_lines (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  budget_version_id uuid not null references public.teller_budget_versions (id) on delete cascade,
  account_id uuid not null references public.teller_accounts (id),
  period_month date not null,
  amount numeric(14, 2) not null default 0,
  source_kind text not null default 'manual'
    check (source_kind in ('manual', 'import', 'clone', 'actual_baseline', 'prior_version')),
  source_id text,
  notes text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (budget_version_id, account_id, period_month)
);

create index if not exists teller_budget_lines_version_period_idx
  on public.teller_budget_lines (budget_version_id, period_month, account_id);

create index if not exists teller_budget_lines_org_version_idx
  on public.teller_budget_lines (organization_id, budget_version_id);

alter table public.teller_budget_lines enable row level security;

create policy "teller members read budget lines"
  on public.teller_budget_lines for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage budget lines"
  on public.teller_budget_lines for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Planning audit events
-- ---------------------------------------------------------------------------

create table if not exists public.teller_planning_audit_events (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  actor_id uuid references auth.users (id),
  event_kind text not null,
  entity_kind text not null,
  entity_id uuid not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists teller_planning_audit_org_created_idx
  on public.teller_planning_audit_events (organization_id, created_at desc);

create index if not exists teller_planning_audit_entity_idx
  on public.teller_planning_audit_events (entity_kind, entity_id);

alter table public.teller_planning_audit_events enable row level security;

create policy "teller members read planning audit"
  on public.teller_planning_audit_events for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers insert planning audit"
  on public.teller_planning_audit_events for insert
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Forecast / scenario / cash schema-only foundations (Phase 14D+)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_forecasts (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  name text not null,
  forecast_kind text not null default 'rolling_pl'
    check (forecast_kind in ('rolling_pl')),
  anchor_month date,
  horizon_months int not null default 12,
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.teller_forecasts enable row level security;

create policy "teller members read forecasts"
  on public.teller_forecasts for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage forecasts"
  on public.teller_forecasts for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

create table if not exists public.teller_forecast_versions (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  forecast_id uuid not null references public.teller_forecasts (id) on delete cascade,
  version_number int not null check (version_number >= 1),
  status text not null default 'draft'
    check (status in ('draft', 'published', 'archived')),
  published_at timestamptz,
  actual_cutoff_month date,
  is_immutable boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (forecast_id, version_number)
);

alter table public.teller_forecast_versions enable row level security;

create policy "teller members read forecast versions"
  on public.teller_forecast_versions for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage forecast versions"
  on public.teller_forecast_versions for all
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

create or replace function public.teller_guard_budget_version_org()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_budget_org uuid;
begin
  select organization_id into v_budget_org
  from public.teller_budgets
  where id = new.budget_id;

  if v_budget_org is null then
    raise exception 'Budget not found';
  end if;

  if new.organization_id is distinct from v_budget_org then
    raise exception 'Budget version organization must match budget organization';
  end if;

  return new;
end;
$$;

create trigger teller_budget_versions_org_guard
  before insert or update on public.teller_budget_versions
  for each row execute function public.teller_guard_budget_version_org();

create or replace function public.teller_guard_budget_line_org()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_version_org uuid;
  v_account_org uuid;
begin
  select organization_id into v_version_org
  from public.teller_budget_versions
  where id = coalesce(new.budget_version_id, old.budget_version_id);

  if v_version_org is null then
    raise exception 'Budget version not found';
  end if;

  if coalesce(new.organization_id, old.organization_id) is distinct from v_version_org then
    raise exception 'Budget line organization must match version organization';
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

create trigger teller_budget_lines_org_guard
  before insert or update or delete on public.teller_budget_lines
  for each row execute function public.teller_guard_budget_line_org();

-- ---------------------------------------------------------------------------
-- Approved / locked immutability on budget lines
-- ---------------------------------------------------------------------------

create or replace function public.teller_guard_budget_line_editable()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_status text;
begin
  select bv.status into v_status
  from public.teller_budget_versions bv
  where bv.id = coalesce(new.budget_version_id, old.budget_version_id);

  if v_status in ('approved', 'locked', 'archived') then
    raise exception 'Budget version is not editable (status: %)', v_status;
  end if;

  return coalesce(new, old);
end;
$$;

create trigger teller_budget_lines_immutability_guard
  before insert or update or delete on public.teller_budget_lines
  for each row execute function public.teller_guard_budget_line_editable();

-- ---------------------------------------------------------------------------
-- RPC: approve budget version
-- ---------------------------------------------------------------------------

create or replace function public.teller_atomic_approve_budget_version(
  p_organization_id uuid,
  p_version_id uuid,
  p_actor_id uuid
)
returns public.teller_budget_versions
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.teller_budget_versions;
begin
  if not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to approve budgets';
  end if;

  select * into v_row
  from public.teller_budget_versions
  where id = p_version_id
    and organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'Budget version not found';
  end if;

  if v_row.status not in ('draft', 'submitted') then
    raise exception 'Only draft or submitted versions can be approved (current: %)', v_row.status;
  end if;

  update public.teller_budget_versions
  set
    status = 'approved',
    approved_at = now(),
    approved_by = p_actor_id,
    updated_at = now()
  where id = p_version_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.teller_atomic_approve_budget_version(uuid, uuid, uuid) from public;
grant execute on function public.teller_atomic_approve_budget_version(uuid, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: lock budget version
-- ---------------------------------------------------------------------------

create or replace function public.teller_atomic_lock_budget_version(
  p_organization_id uuid,
  p_version_id uuid,
  p_actor_id uuid
)
returns public.teller_budget_versions
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.teller_budget_versions;
begin
  if not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to lock budgets';
  end if;

  select * into v_row
  from public.teller_budget_versions
  where id = p_version_id
    and organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'Budget version not found';
  end if;

  if v_row.status <> 'approved' then
    raise exception 'Only approved versions can be locked (current: %)', v_row.status;
  end if;

  update public.teller_budget_versions
  set
    status = 'locked',
    locked_at = now(),
    updated_at = now()
  where id = p_version_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.teller_atomic_lock_budget_version(uuid, uuid, uuid) from public;
grant execute on function public.teller_atomic_lock_budget_version(uuid, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: clone budget version → new draft version + lines
-- ---------------------------------------------------------------------------

create or replace function public.teller_atomic_clone_budget_version(
  p_organization_id uuid,
  p_source_version_id uuid,
  p_actor_id uuid,
  p_label text default ''
)
returns public.teller_budget_versions
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_source public.teller_budget_versions;
  v_next int;
  v_new public.teller_budget_versions;
begin
  if not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to clone budgets';
  end if;

  select * into v_source
  from public.teller_budget_versions
  where id = p_source_version_id
    and organization_id = p_organization_id;

  if not found then
    raise exception 'Source budget version not found';
  end if;

  select coalesce(max(version_number), 0) + 1 into v_next
  from public.teller_budget_versions
  where budget_id = v_source.budget_id;

  insert into public.teller_budget_versions (
    organization_id,
    budget_id,
    version_number,
    label,
    status,
    baseline_kind,
    baseline_version_id,
    source_version_id,
    notes,
    created_by
  ) values (
    v_source.organization_id,
    v_source.budget_id,
    v_next,
    coalesce(nullif(trim(p_label), ''), 'Revision ' || v_next::text),
    'draft',
    'prior_version',
    v_source.id,
    v_source.id,
    '',
    p_actor_id
  )
  returning * into v_new;

  insert into public.teller_budget_lines (
    organization_id,
    budget_version_id,
    account_id,
    period_month,
    amount,
    source_kind,
    source_id,
    notes
  )
  select
    bl.organization_id,
    v_new.id,
    bl.account_id,
    bl.period_month,
    bl.amount,
    'clone',
    v_source.id::text,
    bl.notes
  from public.teller_budget_lines bl
  where bl.budget_version_id = v_source.id
    and bl.organization_id = p_organization_id;

  return v_new;
end;
$$;

revoke all on function public.teller_atomic_clone_budget_version(uuid, uuid, uuid, text) from public;
grant execute on function public.teller_atomic_clone_budget_version(uuid, uuid, uuid, text) to authenticated;
