-- Phase 15F — tax filing periods + immutable period snapshots (manual apply only).

create table if not exists public.teller_tax_filing_periods (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  registration_id uuid not null references public.teller_tax_registrations (id) on delete cascade,
  authority_id uuid references public.teller_tax_authorities (id) on delete set null,
  jurisdiction_key text references public.teller_tax_jurisdictions (jurisdiction_key) on delete restrict,
  period_start date not null,
  period_end date not null,
  filing_frequency text not null
    check (filing_frequency in ('monthly', 'quarterly', 'annual', 'other')),
  status text not null default 'open'
    check (status in ('open', 'ready_for_review', 'reviewed', 'filed', 'closed', 'needs_review')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (period_end >= period_start),
  unique (organization_id, registration_id, period_start, period_end)
);

create index if not exists teller_tax_filing_periods_org_dates_idx
  on public.teller_tax_filing_periods (organization_id, period_start desc, period_end desc);

create index if not exists teller_tax_filing_periods_registration_idx
  on public.teller_tax_filing_periods (registration_id, period_start desc);

alter table public.teller_tax_filing_periods enable row level security;

create policy "teller members read tax filing periods"
  on public.teller_tax_filing_periods for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage tax filing periods"
  on public.teller_tax_filing_periods for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

create table if not exists public.teller_tax_filing_period_snapshots (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  filing_period_id uuid not null references public.teller_tax_filing_periods (id) on delete cascade,
  snapshot_kind text not null
    check (snapshot_kind in ('reconciliation', 'reviewed', 'filed')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists teller_tax_filing_period_snapshots_period_idx
  on public.teller_tax_filing_period_snapshots (filing_period_id, created_at desc);

alter table public.teller_tax_filing_period_snapshots enable row level security;

create policy "teller members read tax filing period snapshots"
  on public.teller_tax_filing_period_snapshots for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers insert tax filing period snapshots"
  on public.teller_tax_filing_period_snapshots for insert
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

create or replace function public.teller_guard_tax_filing_period_org()
returns trigger
language plpgsql
as $$
declare
  reg_org uuid;
  auth_org uuid;
begin
  select organization_id into reg_org from public.teller_tax_registrations where id = new.registration_id;
  if reg_org is distinct from new.organization_id then
    raise exception 'Filing period registration must belong to organization';
  end if;
  if new.authority_id is not null then
    select organization_id into auth_org from public.teller_tax_authorities where id = new.authority_id;
    if auth_org is not null and auth_org is distinct from new.organization_id then
      raise exception 'Filing period authority must belong to organization';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists teller_tax_filing_periods_org_guard on public.teller_tax_filing_periods;
create trigger teller_tax_filing_periods_org_guard
  before insert or update on public.teller_tax_filing_periods
  for each row execute function public.teller_guard_tax_filing_period_org();

create or replace function public.teller_guard_tax_filing_period_snapshot_immutable()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'Tax filing period snapshots are immutable';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Tax filing period snapshots are immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists teller_tax_filing_period_snapshots_immutable on public.teller_tax_filing_period_snapshots;
create trigger teller_tax_filing_period_snapshots_immutable
  before update or delete on public.teller_tax_filing_period_snapshots
  for each row execute function public.teller_guard_tax_filing_period_snapshot_immutable();

create or replace function public.teller_guard_tax_filing_period_snapshot_org()
returns trigger
language plpgsql
as $$
declare
  period_org uuid;
begin
  select organization_id into period_org from public.teller_tax_filing_periods where id = new.filing_period_id;
  if period_org is distinct from new.organization_id then
    raise exception 'Filing period snapshot must belong to organization';
  end if;
  return new;
end;
$$;

drop trigger if exists teller_tax_filing_period_snapshots_org_guard on public.teller_tax_filing_period_snapshots;
create trigger teller_tax_filing_period_snapshots_org_guard
  before insert on public.teller_tax_filing_period_snapshots
  for each row execute function public.teller_guard_tax_filing_period_snapshot_org();
