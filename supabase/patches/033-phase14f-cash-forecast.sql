-- Phase 14F: 13-week cash planning tables (manual patch — operator applies)
-- Additive only. Does NOT modify teller_post_journal or accounting tables.

-- ---------------------------------------------------------------------------
-- Cash forecast runs
-- ---------------------------------------------------------------------------

create table if not exists public.teller_cash_forecast_runs (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  as_of_date date not null,
  horizon_weeks int not null default 13 check (horizon_weeks between 1 and 52),
  horizon_start date not null,
  horizon_end date not null,
  starting_cash numeric(14, 2) not null default 0,
  settings_snapshot jsonb not null default '{}'::jsonb,
  status text not null default 'draft' check (status in ('draft', 'published')),
  published_at timestamptz,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists teller_cash_forecast_runs_org_created_idx
  on public.teller_cash_forecast_runs (organization_id, created_at desc);

alter table public.teller_cash_forecast_runs enable row level security;

create policy "teller members read cash forecast runs"
  on public.teller_cash_forecast_runs for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage cash forecast runs"
  on public.teller_cash_forecast_runs for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Cash forecast detail lines (per source, per week)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_cash_forecast_lines (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  cash_forecast_run_id uuid not null references public.teller_cash_forecast_runs (id) on delete cascade,
  period_start date not null,
  period_end date not null,
  period_grain text not null default 'week' check (period_grain in ('week', 'month')),
  flow_kind text not null check (flow_kind in ('inflow', 'outflow')),
  category text not null,
  amount numeric(14, 2) not null default 0,
  source_kind text not null default 'manual',
  source_id text,
  explanation text not null default '',
  is_override boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists teller_cash_forecast_lines_run_period_idx
  on public.teller_cash_forecast_lines (cash_forecast_run_id, period_start, flow_kind);

create index if not exists teller_cash_forecast_lines_org_run_idx
  on public.teller_cash_forecast_lines (organization_id, cash_forecast_run_id);

alter table public.teller_cash_forecast_lines enable row level security;

create policy "teller members read cash forecast lines"
  on public.teller_cash_forecast_lines for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage cash forecast lines"
  on public.teller_cash_forecast_lines for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Manual cash adjustments (planning-only, org-scoped)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_cash_forecast_overrides (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  effective_date date not null,
  flow_kind text not null check (flow_kind in ('inflow', 'outflow')),
  amount numeric(14, 2) not null check (amount > 0),
  label text not null,
  notes text not null default '',
  active boolean not null default true,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists teller_cash_forecast_overrides_org_date_idx
  on public.teller_cash_forecast_overrides (organization_id, effective_date)
  where active = true;

alter table public.teller_cash_forecast_overrides enable row level security;

create policy "teller members read cash overrides"
  on public.teller_cash_forecast_overrides for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage cash overrides"
  on public.teller_cash_forecast_overrides for all
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

create or replace function public.teller_guard_cash_forecast_line_org()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_run_org uuid;
begin
  select organization_id into v_run_org
  from public.teller_cash_forecast_runs
  where id = coalesce(new.cash_forecast_run_id, old.cash_forecast_run_id);

  if v_run_org is null then
    raise exception 'Cash forecast run not found';
  end if;

  if coalesce(new.organization_id, old.organization_id) is distinct from v_run_org then
    raise exception 'Cash forecast line organization must match run organization';
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists teller_cash_forecast_lines_org_guard on public.teller_cash_forecast_lines;
create trigger teller_cash_forecast_lines_org_guard
  before insert or update on public.teller_cash_forecast_lines
  for each row execute function public.teller_guard_cash_forecast_line_org();
