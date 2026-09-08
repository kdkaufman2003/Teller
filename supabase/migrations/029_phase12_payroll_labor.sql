-- Phase 12: Payroll & labor accounting (additive, Phase 11.1 compatible)
-- Local only — do not apply to production until Phase 12 acceptance.
-- Teller is NOT a payroll processor; this stores accounting economics from external providers.

-- ---------------------------------------------------------------------------
-- Workers (lightweight accounting identity — no SSN/bank/tax forms)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_workers (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  external_provider text not null default 'manual',
  external_worker_id text,
  display_name text not null,
  worker_type text not null default 'employee',
  status text not null default 'active',
  party_id uuid references public.teller_parties (id),
  default_labor_account_id uuid references public.teller_accounts (id),
  default_job_cost_account_id uuid references public.teller_accounts (id),
  default_job_cost_category_id uuid references public.teller_job_cost_categories (id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint teller_workers_type_check check (worker_type in ('employee', 'contractor')),
  constraint teller_workers_status_check check (status in ('active', 'inactive')),
  unique (organization_id, external_provider, external_worker_id)
);

create index if not exists teller_workers_org_status_idx
  on public.teller_workers (organization_id, status);

create index if not exists teller_workers_org_provider_idx
  on public.teller_workers (organization_id, external_provider);

alter table public.teller_workers enable row level security;

create policy "teller members read workers"
  on public.teller_workers for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage workers"
  on public.teller_workers for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Payroll account mappings (org-level component → GL account)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_payroll_account_mappings (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  component_category text not null,
  account_id uuid not null references public.teller_accounts (id),
  side text not null default 'credit',
  is_required boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint teller_payroll_account_mappings_side_check check (side in ('debit', 'credit')),
  unique (organization_id, component_category)
);

create index if not exists teller_payroll_account_mappings_org_idx
  on public.teller_payroll_account_mappings (organization_id);

alter table public.teller_payroll_account_mappings enable row level security;

create policy "teller members read payroll mappings"
  on public.teller_payroll_account_mappings for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage payroll mappings"
  on public.teller_payroll_account_mappings for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Payroll runs (canonical provider-neutral payroll event)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_payroll_runs (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  provider text not null default 'manual',
  external_run_id text,
  period_start date not null,
  period_end date not null,
  pay_date date not null,
  status text not null default 'draft',
  gross_wages numeric(14, 2) not null default 0 check (gross_wages >= 0),
  employee_taxes numeric(14, 2) not null default 0 check (employee_taxes >= 0),
  employee_deductions numeric(14, 2) not null default 0 check (employee_deductions >= 0),
  employer_taxes numeric(14, 2) not null default 0 check (employer_taxes >= 0),
  net_pay numeric(14, 2) not null default 0 check (net_pay >= 0),
  total_liability numeric(14, 2) not null default 0 check (total_liability >= 0),
  journal_entry_id uuid references public.teller_journal_entries (id),
  reversal_journal_entry_id uuid references public.teller_journal_entries (id),
  idempotency_key text not null,
  source_metadata jsonb not null default '{}'::jsonb,
  failure_reason text,
  posted_at timestamptz,
  posted_by uuid references auth.users (id),
  reversed_at timestamptz,
  reversed_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint teller_payroll_runs_status_check
    check (status in ('draft', 'imported', 'reviewed', 'posted', 'reversed', 'needs_review')),
  unique (organization_id, idempotency_key),
  unique (organization_id, provider, external_run_id)
);

create index if not exists teller_payroll_runs_org_status_idx
  on public.teller_payroll_runs (organization_id, status, pay_date);

create index if not exists teller_payroll_runs_org_provider_idx
  on public.teller_payroll_runs (organization_id, provider, external_run_id);

create index if not exists teller_payroll_runs_org_pay_date_idx
  on public.teller_payroll_runs (organization_id, pay_date);

alter table public.teller_payroll_runs enable row level security;

create policy "teller members read payroll runs"
  on public.teller_payroll_runs for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage payroll runs"
  on public.teller_payroll_runs for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Payroll run components (configurable category model)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_payroll_components (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  payroll_run_id uuid not null references public.teller_payroll_runs (id) on delete cascade,
  worker_id uuid references public.teller_workers (id),
  component_category text not null,
  amount numeric(14, 2) not null check (amount >= 0),
  side text not null default 'debit',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint teller_payroll_components_side_check check (side in ('debit', 'credit')),
  constraint teller_payroll_components_category_check check (char_length(component_category) > 0)
);

create index if not exists teller_payroll_components_run_idx
  on public.teller_payroll_components (organization_id, payroll_run_id);

create index if not exists teller_payroll_components_worker_idx
  on public.teller_payroll_components (organization_id, worker_id);

alter table public.teller_payroll_components enable row level security;

create policy "teller members read payroll components"
  on public.teller_payroll_components for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage payroll components"
  on public.teller_payroll_components for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Labor entries (job allocation / time detail)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_labor_entries (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  worker_id uuid not null references public.teller_workers (id) on delete cascade,
  payroll_run_id uuid references public.teller_payroll_runs (id) on delete set null,
  job_id uuid references public.teller_jobs (id),
  work_date date not null,
  hours numeric(10, 4),
  labor_type text not null default 'direct',
  gross_amount numeric(14, 2) not null default 0 check (gross_amount >= 0),
  employer_burden_amount numeric(14, 2) not null default 0 check (employer_burden_amount >= 0),
  source text not null default 'manual',
  external_entry_id text,
  allocation_status text not null default 'allocated',
  job_cost_category_id uuid references public.teller_job_cost_categories (id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint teller_labor_entries_labor_type_check
    check (labor_type in ('direct', 'indirect', 'overhead', 'pto', 'training', 'unallocated')),
  constraint teller_labor_entries_allocation_status_check
    check (allocation_status in ('allocated', 'unallocated', 'reversed')),
  unique (organization_id, source, external_entry_id)
);

create index if not exists teller_labor_entries_org_worker_idx
  on public.teller_labor_entries (organization_id, worker_id);

create index if not exists teller_labor_entries_org_run_idx
  on public.teller_labor_entries (organization_id, payroll_run_id);

create index if not exists teller_labor_entries_org_job_idx
  on public.teller_labor_entries (organization_id, job_id);

create index if not exists teller_labor_entries_org_work_date_idx
  on public.teller_labor_entries (organization_id, work_date);

alter table public.teller_labor_entries enable row level security;

create policy "teller members read labor entries"
  on public.teller_labor_entries for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage labor entries"
  on public.teller_labor_entries for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Payroll liability settlements (cash clearing — not duplicate expense)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_payroll_liability_settlements (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  settlement_type text not null,
  payroll_run_id uuid references public.teller_payroll_runs (id),
  bank_transaction_id uuid references public.teller_bank_transactions (id),
  settlement_date date not null,
  amount numeric(14, 2) not null check (amount > 0),
  liability_account_id uuid not null references public.teller_accounts (id),
  cash_account_id uuid not null references public.teller_accounts (id),
  journal_entry_id uuid references public.teller_journal_entries (id),
  idempotency_key text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint teller_payroll_liability_settlements_type_check
    check (settlement_type in ('net_pay', 'tax', 'benefit', 'other')),
  unique (organization_id, idempotency_key)
);

create index if not exists teller_payroll_liability_settlements_org_idx
  on public.teller_payroll_liability_settlements (organization_id, settlement_date);

alter table public.teller_payroll_liability_settlements enable row level security;

create policy "teller members read payroll settlements"
  on public.teller_payroll_liability_settlements for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage payroll settlements"
  on public.teller_payroll_liability_settlements for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );
