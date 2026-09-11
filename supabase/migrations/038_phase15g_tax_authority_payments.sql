-- Phase 15G — tax authority payments, period allocations, manual adjustments (manual apply only).
-- Safe to re-run after partial apply: uses IF NOT EXISTS / DROP IF EXISTS throughout.

alter table public.teller_tax_settings
  add column if not exists tax_penalty_expense_account_id uuid references public.teller_accounts (id) on delete set null,
  add column if not exists tax_interest_expense_account_id uuid references public.teller_accounts (id) on delete set null,
  add column if not exists tax_overpayment_account_id uuid references public.teller_accounts (id) on delete set null;

alter table public.teller_tax_transactions
  add column if not exists registration_id uuid references public.teller_tax_registrations (id) on delete set null,
  add column if not exists filing_period_id uuid references public.teller_tax_filing_periods (id) on delete set null,
  add column if not exists authority_id uuid references public.teller_tax_authorities (id) on delete set null,
  add column if not exists authority_payment_id uuid;

create table if not exists public.teller_tax_authority_payments (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  registration_id uuid not null references public.teller_tax_registrations (id) on delete restrict,
  authority_id uuid references public.teller_tax_authorities (id) on delete set null,
  jurisdiction_key text references public.teller_tax_jurisdictions (jurisdiction_key) on delete restrict,
  payment_date date not null,
  base_tax_amount numeric(14, 2) not null default 0 check (base_tax_amount >= 0),
  penalty_amount numeric(14, 2) not null default 0 check (penalty_amount >= 0),
  interest_amount numeric(14, 2) not null default 0 check (interest_amount >= 0),
  total_amount numeric(14, 2) not null check (total_amount > 0),
  unapplied_amount numeric(14, 2) not null default 0 check (unapplied_amount >= 0),
  cash_account_id uuid not null references public.teller_accounts (id) on delete restrict,
  reference_number text,
  memo text,
  status text not null default 'posted'
    check (status in ('draft', 'posted', 'partially_allocated', 'fully_allocated', 'reversed', 'voided', 'needs_review')),
  journal_entry_id uuid not null references public.teller_journal_entries (id) on delete restrict,
  reversal_journal_entry_id uuid references public.teller_journal_entries (id) on delete set null,
  tax_transaction_id uuid references public.teller_tax_transactions (id) on delete set null,
  idempotency_key text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (total_amount >= base_tax_amount)
);

create unique index if not exists teller_tax_authority_payments_idempotency_idx
  on public.teller_tax_authority_payments (organization_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists teller_tax_authority_payments_org_date_idx
  on public.teller_tax_authority_payments (organization_id, payment_date desc);

create index if not exists teller_tax_authority_payments_registration_idx
  on public.teller_tax_authority_payments (registration_id, payment_date desc);

alter table public.teller_tax_transactions
  drop constraint if exists teller_tax_transactions_authority_payment_id_fkey;

alter table public.teller_tax_transactions
  add constraint teller_tax_transactions_authority_payment_id_fkey
  foreign key (authority_payment_id) references public.teller_tax_authority_payments (id) on delete set null;

create table if not exists public.teller_tax_authority_payment_allocations (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  authority_payment_id uuid not null references public.teller_tax_authority_payments (id) on delete cascade,
  filing_period_id uuid not null references public.teller_tax_filing_periods (id) on delete restrict,
  registration_id uuid not null references public.teller_tax_registrations (id) on delete restrict,
  allocated_amount numeric(14, 2) not null check (allocated_amount > 0),
  created_at timestamptz not null default now()
);

create index if not exists teller_tax_authority_payment_allocations_period_idx
  on public.teller_tax_authority_payment_allocations (filing_period_id, created_at desc);

create table if not exists public.teller_tax_manual_adjustments (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  registration_id uuid references public.teller_tax_registrations (id) on delete set null,
  filing_period_id uuid references public.teller_tax_filing_periods (id) on delete set null,
  authority_id uuid references public.teller_tax_authorities (id) on delete set null,
  jurisdiction_key text references public.teller_tax_jurisdictions (jurisdiction_key) on delete restrict,
  adjustment_date date not null,
  amount numeric(14, 2) not null check (amount > 0),
  direction text not null check (direction in ('increase_liability', 'decrease_liability')),
  reason_code text not null,
  reason_notes text,
  offset_account_id uuid not null references public.teller_accounts (id) on delete restrict,
  status text not null default 'posted' check (status in ('posted', 'reversed')),
  journal_entry_id uuid not null references public.teller_journal_entries (id) on delete restrict,
  reversal_journal_entry_id uuid references public.teller_journal_entries (id) on delete set null,
  tax_transaction_id uuid references public.teller_tax_transactions (id) on delete set null,
  idempotency_key text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

create unique index if not exists teller_tax_manual_adjustments_idempotency_idx
  on public.teller_tax_manual_adjustments (organization_id, idempotency_key)
  where idempotency_key is not null;

alter table public.teller_tax_authority_payments enable row level security;
alter table public.teller_tax_authority_payment_allocations enable row level security;
alter table public.teller_tax_manual_adjustments enable row level security;

drop policy if exists "teller members read tax authority payments" on public.teller_tax_authority_payments;
create policy "teller members read tax authority payments"
  on public.teller_tax_authority_payments for select
  using (public.teller_is_org_member(organization_id));

drop policy if exists "teller writers manage tax authority payments" on public.teller_tax_authority_payments;
create policy "teller writers manage tax authority payments"
  on public.teller_tax_authority_payments for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

drop policy if exists "teller members read tax payment allocations" on public.teller_tax_authority_payment_allocations;
create policy "teller members read tax payment allocations"
  on public.teller_tax_authority_payment_allocations for select
  using (public.teller_is_org_member(organization_id));

drop policy if exists "teller writers manage tax payment allocations" on public.teller_tax_authority_payment_allocations;
create policy "teller writers manage tax payment allocations"
  on public.teller_tax_authority_payment_allocations for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

drop policy if exists "teller members read tax manual adjustments" on public.teller_tax_manual_adjustments;
create policy "teller members read tax manual adjustments"
  on public.teller_tax_manual_adjustments for select
  using (public.teller_is_org_member(organization_id));

drop policy if exists "teller writers manage tax manual adjustments" on public.teller_tax_manual_adjustments;
create policy "teller writers manage tax manual adjustments"
  on public.teller_tax_manual_adjustments for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

create or replace function public.teller_guard_tax_authority_payment_org()
returns trigger
language plpgsql
as $$
declare
  reg_org uuid;
  cash_org uuid;
  journal_org uuid;
begin
  select organization_id into reg_org from public.teller_tax_registrations where id = new.registration_id;
  if reg_org is distinct from new.organization_id then
    raise exception 'Tax authority payment registration must belong to organization';
  end if;
  select organization_id into cash_org from public.teller_accounts where id = new.cash_account_id;
  if cash_org is distinct from new.organization_id then
    raise exception 'Tax authority payment cash account must belong to organization';
  end if;
  select organization_id into journal_org from public.teller_journal_entries where id = new.journal_entry_id;
  if journal_org is distinct from new.organization_id then
    raise exception 'Tax authority payment journal must belong to organization';
  end if;
  return new;
end;
$$;

drop trigger if exists teller_tax_authority_payments_org_guard on public.teller_tax_authority_payments;
create trigger teller_tax_authority_payments_org_guard
  before insert or update on public.teller_tax_authority_payments
  for each row execute function public.teller_guard_tax_authority_payment_org();

create or replace function public.teller_guard_tax_payment_allocation_org()
returns trigger
language plpgsql
as $$
declare
  payment_org uuid;
  period_org uuid;
  reg_org uuid;
begin
  select organization_id into payment_org from public.teller_tax_authority_payments where id = new.authority_payment_id;
  if payment_org is distinct from new.organization_id then
    raise exception 'Payment allocation payment must belong to organization';
  end if;
  select organization_id into period_org from public.teller_tax_filing_periods where id = new.filing_period_id;
  if period_org is distinct from new.organization_id then
    raise exception 'Payment allocation filing period must belong to organization';
  end if;
  select organization_id into reg_org from public.teller_tax_registrations where id = new.registration_id;
  if reg_org is distinct from new.organization_id then
    raise exception 'Payment allocation registration must belong to organization';
  end if;
  return new;
end;
$$;

drop trigger if exists teller_tax_payment_allocations_org_guard on public.teller_tax_authority_payment_allocations;
create trigger teller_tax_payment_allocations_org_guard
  before insert or update on public.teller_tax_authority_payment_allocations
  for each row execute function public.teller_guard_tax_payment_allocation_org();

create or replace function public.teller_guard_tax_manual_adjustment_org()
returns trigger
language plpgsql
as $$
declare
  reg_org uuid;
  offset_org uuid;
  journal_org uuid;
begin
  if new.registration_id is not null then
    select organization_id into reg_org from public.teller_tax_registrations where id = new.registration_id;
    if reg_org is distinct from new.organization_id then
      raise exception 'Tax manual adjustment registration must belong to organization';
    end if;
  end if;
  select organization_id into offset_org from public.teller_accounts where id = new.offset_account_id;
  if offset_org is distinct from new.organization_id then
    raise exception 'Tax manual adjustment offset account must belong to organization';
  end if;
  select organization_id into journal_org from public.teller_journal_entries where id = new.journal_entry_id;
  if journal_org is distinct from new.organization_id then
    raise exception 'Tax manual adjustment journal must belong to organization';
  end if;
  return new;
end;
$$;

drop trigger if exists teller_tax_manual_adjustments_org_guard on public.teller_tax_manual_adjustments;
create trigger teller_tax_manual_adjustments_org_guard
  before insert or update on public.teller_tax_manual_adjustments
  for each row execute function public.teller_guard_tax_manual_adjustment_org();

create or replace function public.teller_guard_tax_transaction_org()
returns trigger
language plpgsql
as $$
declare
  doc_org uuid;
  line_org uuid;
  reg_org uuid;
  period_org uuid;
begin
  if new.document_id is not null then
    select organization_id into doc_org from public.teller_documents where id = new.document_id;
    if doc_org is distinct from new.organization_id then
      raise exception 'Tax transaction document must belong to organization';
    end if;
  end if;
  if new.line_id is not null then
    select d.organization_id into line_org
    from public.teller_document_lines l
    join public.teller_documents d on d.id = l.document_id
    where l.id = new.line_id;
    if line_org is distinct from new.organization_id then
      raise exception 'Tax transaction line must belong to organization';
    end if;
  end if;
  if new.posted_journal_entry_id is not null then
    select organization_id into doc_org from public.teller_journal_entries where id = new.posted_journal_entry_id;
    if doc_org is distinct from new.organization_id then
      raise exception 'Tax transaction journal must belong to organization';
    end if;
  end if;
  if new.registration_id is not null then
    select organization_id into reg_org from public.teller_tax_registrations where id = new.registration_id;
    if reg_org is distinct from new.organization_id then
      raise exception 'Tax transaction registration must belong to organization';
    end if;
  end if;
  if new.filing_period_id is not null then
    select organization_id into period_org from public.teller_tax_filing_periods where id = new.filing_period_id;
    if period_org is distinct from new.organization_id then
      raise exception 'Tax transaction filing period must belong to organization';
    end if;
  end if;
  if new.authority_payment_id is not null then
    select organization_id into reg_org from public.teller_tax_authority_payments where id = new.authority_payment_id;
    if reg_org is distinct from new.organization_id then
      raise exception 'Tax transaction authority payment must belong to organization';
    end if;
  end if;
  return new;
end;
$$;
