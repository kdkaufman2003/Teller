-- Phase 11.1: Accrual-to-bill settlement + scheduler run history (additive, Phase 11 compatible)
-- Local only — do not apply to production until Phase 11.1 acceptance.

-- ---------------------------------------------------------------------------
-- Accrual settlements (bill-linked clearing of accrued liabilities)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_accrual_settlements (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  bill_id uuid not null references public.teller_documents (id),
  status text not null default 'draft',
  settlement_method text not null default 'bill_post',
  settlement_journal_entry_id uuid references public.teller_journal_entries (id),
  reversal_journal_entry_id uuid references public.teller_journal_entries (id),
  actual_amount numeric(14, 2) not null check (actual_amount >= 0),
  estimated_amount numeric(14, 2) not null check (estimated_amount >= 0),
  variance_amount numeric(14, 2) not null default 0,
  accrual_settlement_portion numeric(14, 2) not null default 0,
  new_expense_portion numeric(14, 2) not null default 0,
  purchase_tax_portion numeric(14, 2) not null default 0,
  idempotency_key text not null,
  settled_at timestamptz,
  settled_by uuid references auth.users (id),
  reversed_at timestamptz,
  reversed_by uuid references auth.users (id),
  failure_reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint teller_accrual_settlements_status_check
    check (status in ('draft', 'posted', 'partially_settled', 'settled', 'reversed', 'failed', 'needs_review')),
  constraint teller_accrual_settlements_method_check
    check (settlement_method in ('bill_post', 'manual')),
  unique (organization_id, idempotency_key),
  unique (organization_id, bill_id)
);

create index if not exists teller_accrual_settlements_org_status_idx
  on public.teller_accrual_settlements (organization_id, status, settled_at);

create index if not exists teller_accrual_settlements_org_bill_idx
  on public.teller_accrual_settlements (organization_id, bill_id);

alter table public.teller_accrual_settlements enable row level security;

create policy "teller members read accrual settlements"
  on public.teller_accrual_settlements for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage accrual settlements"
  on public.teller_accrual_settlements for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Per-occurrence settlement allocations (immutable posted history)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_accrual_settlement_allocations (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  settlement_id uuid not null references public.teller_accrual_settlements (id) on delete cascade,
  occurrence_id uuid not null references public.teller_schedule_occurrences (id),
  estimated_amount numeric(14, 2) not null check (estimated_amount >= 0),
  applied_amount numeric(14, 2) not null check (applied_amount >= 0),
  actual_amount_allocated numeric(14, 2) not null check (actual_amount_allocated >= 0),
  actual_pre_tax_allocated numeric(14, 2) not null default 0,
  nonrecoverable_tax_allocated numeric(14, 2) not null default 0,
  recoverable_tax_allocated numeric(14, 2) not null default 0,
  variance_amount numeric(14, 2) not null default 0,
  accrued_liability_account_id uuid not null references public.teller_accounts (id),
  expense_account_id uuid not null references public.teller_accounts (id),
  status text not null default 'posted',
  created_at timestamptz not null default now(),
  constraint teller_accrual_settlement_allocations_status_check
    check (status in ('posted', 'reversed')),
  unique (settlement_id, occurrence_id)
);

create index if not exists teller_accrual_settlement_alloc_org_occ_idx
  on public.teller_accrual_settlement_allocations (organization_id, occurrence_id, status);

create index if not exists teller_accrual_settlement_alloc_bill_lookup_idx
  on public.teller_accrual_settlement_allocations (organization_id, settlement_id);

alter table public.teller_accrual_settlement_allocations enable row level security;

create policy "teller members read accrual settlement allocations"
  on public.teller_accrual_settlement_allocations for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage accrual settlement allocations"
  on public.teller_accrual_settlement_allocations for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- Prevent over-settlement at DB level (posted allocations only)
create or replace function public.teller_accrual_allocation_capacity_check()
returns trigger
language plpgsql
as $$
declare
  occ_amount numeric(14, 2);
  settled_total numeric(14, 2);
begin
  select o.amount
    into occ_amount
  from public.teller_schedule_occurrences o
  where o.id = new.occurrence_id
    and o.organization_id = new.organization_id;

  if occ_amount is null then
    raise exception 'Accrual occurrence not found for allocation';
  end if;

  select coalesce(sum(a.applied_amount), 0)
    into settled_total
  from public.teller_accrual_settlement_allocations a
  join public.teller_accrual_settlements s on s.id = a.settlement_id
  where a.occurrence_id = new.occurrence_id
    and a.organization_id = new.organization_id
    and a.status = 'posted'
    and s.status = 'posted'
    and (tg_op = 'INSERT' or a.id <> new.id);

  if new.status = 'posted' and settled_total + new.applied_amount > occ_amount + 0.001 then
    raise exception 'Accrual allocation exceeds unsettled capacity';
  end if;

  return new;
end;
$$;

drop trigger if exists teller_accrual_allocation_capacity_trg
  on public.teller_accrual_settlement_allocations;

create trigger teller_accrual_allocation_capacity_trg
  before insert or update of applied_amount, status
  on public.teller_accrual_settlement_allocations
  for each row
  execute function public.teller_accrual_allocation_capacity_check();

-- ---------------------------------------------------------------------------
-- Scheduler run history (production cron readiness — not enabled by default)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_scheduler_runs (
  id uuid primary key default uuid_generate_v4(),
  run_id text not null unique,
  organization_id uuid references public.teller_organizations (id) on delete set null,
  trigger_type text not null,
  status text not null,
  dry_run boolean not null default false,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  schedules_scanned integer not null default 0,
  occurrences_generated integer not null default 0,
  occurrences_posted integer not null default 0,
  failures integer not null default 0,
  duration_ms integer,
  metadata jsonb not null default '{}'::jsonb,
  constraint teller_scheduler_runs_trigger_check
    check (trigger_type in ('cron', 'manual', 'dry_run')),
  constraint teller_scheduler_runs_status_check
    check (status in ('running', 'completed', 'failed', 'partial'))
);

create index if not exists teller_scheduler_runs_started_idx
  on public.teller_scheduler_runs (started_at desc);

create index if not exists teller_scheduler_runs_org_idx
  on public.teller_scheduler_runs (organization_id, started_at desc);

alter table public.teller_scheduler_runs enable row level security;

create policy "teller members read scheduler runs"
  on public.teller_scheduler_runs for select
  using (
    organization_id is null
    or public.teller_is_org_member(organization_id)
  );

create policy "service role manages scheduler runs"
  on public.teller_scheduler_runs for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
