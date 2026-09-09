-- Phase 14H: Scenario planning tables (manual patch — operator applies)
-- Additive only. Does NOT modify teller_post_journal or accounting tables.

-- ---------------------------------------------------------------------------
-- Scenarios
-- ---------------------------------------------------------------------------

create table if not exists public.teller_scenarios (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  forecast_id uuid not null references public.teller_forecasts (id) on delete cascade,
  forecast_version_id uuid not null references public.teller_forecast_versions (id) on delete restrict,
  name text not null,
  scenario_type text not null default 'custom'
    check (scenario_type in ('base', 'downside', 'upside', 'custom')),
  is_system boolean not null default false,
  status text not null default 'draft'
    check (status in ('draft', 'active', 'archived')),
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists teller_scenarios_org_status_idx
  on public.teller_scenarios (organization_id, status, updated_at desc);

create index if not exists teller_scenarios_forecast_version_idx
  on public.teller_scenarios (forecast_version_id);

alter table public.teller_scenarios enable row level security;

create policy "teller members read scenarios"
  on public.teller_scenarios for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage scenarios"
  on public.teller_scenarios for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Scenario drivers (structured overlays — never mutate source forecast)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_scenario_drivers (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  scenario_id uuid not null references public.teller_scenarios (id) on delete cascade,
  driver_type text not null check (
    driver_type in (
      'revenue_percentage',
      'cogs_percentage',
      'expense_percentage',
      'gross_margin_points',
      'ar_days_adjustment',
      'ap_days_adjustment',
      'payroll_percentage',
      'purchasing_percentage',
      'capex_percentage',
      'note'
    )
  ),
  value_numeric numeric(14, 4),
  value_text text not null default '',
  target_scope text not null default 'all',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (scenario_id, driver_type)
);

create index if not exists teller_scenario_drivers_scenario_idx
  on public.teller_scenario_drivers (scenario_id);

alter table public.teller_scenario_drivers enable row level security;

create policy "teller members read scenario drivers"
  on public.teller_scenario_drivers for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage scenario drivers"
  on public.teller_scenario_drivers for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Scenario-only manual cash adjustments (planning overlay)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_scenario_cash_adjustments (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  scenario_id uuid not null references public.teller_scenarios (id) on delete cascade,
  effective_date date not null,
  flow_kind text not null check (flow_kind in ('inflow', 'outflow')),
  amount numeric(14, 2) not null check (amount > 0),
  label text not null,
  notes text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists teller_scenario_cash_adjustments_scenario_idx
  on public.teller_scenario_cash_adjustments (scenario_id)
  where active = true;

alter table public.teller_scenario_cash_adjustments enable row level security;

create policy "teller members read scenario cash adjustments"
  on public.teller_scenario_cash_adjustments for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage scenario cash adjustments"
  on public.teller_scenario_cash_adjustments for all
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

create or replace function public.teller_guard_scenario_forecast_org()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_forecast_org uuid;
  v_version_org uuid;
  v_version_forecast uuid;
begin
  select organization_id into v_forecast_org
  from public.teller_forecasts
  where id = new.forecast_id;

  if v_forecast_org is null then
    raise exception 'Forecast not found';
  end if;

  select organization_id, forecast_id into v_version_org, v_version_forecast
  from public.teller_forecast_versions
  where id = new.forecast_version_id;

  if v_version_org is null then
    raise exception 'Forecast version not found';
  end if;

  if new.organization_id is distinct from v_forecast_org
     or new.organization_id is distinct from v_version_org then
    raise exception 'Scenario organization must match forecast organization';
  end if;

  if new.forecast_id is distinct from v_version_forecast then
    raise exception 'Scenario forecast version must belong to scenario forecast';
  end if;

  return new;
end;
$$;

drop trigger if exists teller_scenarios_forecast_org_guard on public.teller_scenarios;
create trigger teller_scenarios_forecast_org_guard
  before insert or update on public.teller_scenarios
  for each row execute function public.teller_guard_scenario_forecast_org();

create or replace function public.teller_guard_scenario_driver_org()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_scenario_org uuid;
begin
  select organization_id into v_scenario_org
  from public.teller_scenarios
  where id = coalesce(new.scenario_id, old.scenario_id);

  if v_scenario_org is null then
    raise exception 'Scenario not found';
  end if;

  if coalesce(new.organization_id, old.organization_id) is distinct from v_scenario_org then
    raise exception 'Scenario driver organization must match scenario organization';
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists teller_scenario_drivers_org_guard on public.teller_scenario_drivers;
create trigger teller_scenario_drivers_org_guard
  before insert or update on public.teller_scenario_drivers
  for each row execute function public.teller_guard_scenario_driver_org();

create or replace function public.teller_guard_scenario_cash_adjustment_org()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_scenario_org uuid;
begin
  select organization_id into v_scenario_org
  from public.teller_scenarios
  where id = coalesce(new.scenario_id, old.scenario_id);

  if v_scenario_org is null then
    raise exception 'Scenario not found';
  end if;

  if coalesce(new.organization_id, old.organization_id) is distinct from v_scenario_org then
    raise exception 'Scenario cash adjustment organization must match scenario organization';
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists teller_scenario_cash_adjustments_org_guard on public.teller_scenario_cash_adjustments;
create trigger teller_scenario_cash_adjustments_org_guard
  before insert or update on public.teller_scenario_cash_adjustments
  for each row execute function public.teller_guard_scenario_cash_adjustment_org();
