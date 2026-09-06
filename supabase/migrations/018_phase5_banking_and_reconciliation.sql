-- Phase 5A: Banking domain foundation — extend 009, matches, reconciliation schema
-- Extends existing teller_bank_* tables; does not create a parallel banking system.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public.teller_bank_account_gl_kind(p_bank_account_id uuid)
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select case
    when gl.type = 'liability'
      or lower(coalesce(ba.account_type, '')) = 'credit'
      or lower(coalesce(ba.account_subtype, '')) like '%credit%'
      then 'credit_card_liability'
    else 'asset_bank'
  end
  from public.teller_bank_accounts ba
  left join public.teller_accounts gl
    on gl.id = coalesce(ba.gl_account_id, ba.teller_account_id)
  where ba.id = p_bank_account_id
  limit 1;
$$;

create or replace function public.teller_compute_normalized_bank_amount(
  p_raw_amount numeric,
  p_gl_kind text
)
returns numeric
language sql
immutable
as $$
  select case
    when coalesce(p_raw_amount, 0) = 0 then 0
    when p_gl_kind = 'credit_card_liability' then p_raw_amount
    else -p_raw_amount
  end;
$$;

create or replace function public.teller_compute_bank_direction(
  p_normalized_amount numeric,
  p_gl_kind text
)
returns text
language sql
immutable
as $$
  select case
    when coalesce(p_normalized_amount, 0) = 0 then null
    when p_gl_kind = 'credit_card_liability' then
      case when p_normalized_amount > 0 then 'charge' else 'payment' end
    else
      case when p_normalized_amount > 0 then 'inflow' else 'outflow' end
  end;
$$;

create or replace function public.teller_validate_bank_gl_account(
  p_organization_id uuid,
  p_gl_account_id uuid,
  p_bank_account_type text,
  p_bank_account_subtype text
)
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_gl record;
  v_is_credit boolean;
begin
  if p_gl_account_id is null then
    return;
  end if;

  select id, organization_id, type, subtype, archived
  into v_gl
  from public.teller_accounts
  where id = p_gl_account_id;

  if not found then
    raise exception 'GL account % does not exist', p_gl_account_id;
  end if;

  if v_gl.organization_id <> p_organization_id then
    raise exception 'GL account % belongs to a different organization', p_gl_account_id;
  end if;

  if v_gl.archived then
    raise exception 'GL account % is archived', p_gl_account_id;
  end if;

  v_is_credit :=
    lower(coalesce(p_bank_account_type, '')) = 'credit'
    or lower(coalesce(p_bank_account_subtype, '')) like '%credit%';

  if v_is_credit then
    if v_gl.type <> 'liability' then
      raise exception 'Credit card bank account requires a liability GL account';
    end if;
  else
    if v_gl.type <> 'asset'
      or (
        coalesce(v_gl.subtype, '') not in ('bank', '')
        and v_gl.subtype is not null
        and v_gl.subtype <> ''
      )
    then
      raise exception 'Asset bank account requires an asset/bank GL account';
    end if;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- teller_bank_connections — sync metadata
-- ---------------------------------------------------------------------------

alter table public.teller_bank_connections
  add column if not exists last_successful_sync_at timestamptz,
  add column if not exists last_attempted_sync_at timestamptz,
  add column if not exists sync_error_code text,
  add column if not exists sync_error_message text;

comment on column public.teller_bank_connections.external_item_id is
  'Provider item/connection id (legacy name; equivalent to provider_item_id).';

update public.teller_bank_connections
set
  last_successful_sync_at = coalesce(last_successful_sync_at, last_synced_at),
  sync_error_message = coalesce(sync_error_message, error_message)
where last_synced_at is not null
   or error_message is not null;

-- ---------------------------------------------------------------------------
-- teller_bank_accounts — GL link, status, sync metadata
-- ---------------------------------------------------------------------------

alter table public.teller_bank_accounts
  add column if not exists gl_account_id uuid references public.teller_accounts (id) on delete set null,
  add column if not exists institution_name text not null default '',
  add column if not exists status text not null default 'active',
  add column if not exists sync_cursor text,
  add column if not exists sync_metadata jsonb not null default '{}'::jsonb;

alter table public.teller_bank_accounts
  drop constraint if exists teller_bank_accounts_status_check;

alter table public.teller_bank_accounts
  add constraint teller_bank_accounts_status_check
  check (status in ('active', 'inactive', 'error', 'disconnected'));

comment on column public.teller_bank_accounts.external_account_id is
  'Provider account id (legacy name; equivalent to provider_account_id).';
comment on column public.teller_bank_accounts.teller_account_id is
  'Legacy GL link — kept for backward compatibility; gl_account_id is canonical.';
comment on column public.teller_bank_accounts.gl_account_id is
  'Linked GL cash/bank or credit-card liability account for this bank feed.';

update public.teller_bank_accounts
set gl_account_id = teller_account_id
where gl_account_id is null
  and teller_account_id is not null;

update public.teller_bank_accounts ba
set institution_name = bc.institution_name
from public.teller_bank_connections bc
where ba.connection_id = bc.id
  and ba.institution_name = '';

create or replace function public.teller_sync_bank_account_gl_ids()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if NEW.gl_account_id is not null and NEW.teller_account_id is null then
    NEW.teller_account_id := NEW.gl_account_id;
  elsif NEW.teller_account_id is not null and NEW.gl_account_id is null then
    NEW.gl_account_id := NEW.teller_account_id;
  elsif NEW.gl_account_id is not null
    and NEW.teller_account_id is not null
    and NEW.gl_account_id <> NEW.teller_account_id then
    NEW.teller_account_id := NEW.gl_account_id;
  end if;

  perform public.teller_validate_bank_gl_account(
    NEW.organization_id,
    NEW.gl_account_id,
    NEW.account_type,
    NEW.account_subtype
  );

  return NEW;
end;
$$;

drop trigger if exists teller_bank_accounts_gl_sync on public.teller_bank_accounts;
create trigger teller_bank_accounts_gl_sync
  before insert or update on public.teller_bank_accounts
  for each row execute function public.teller_sync_bank_account_gl_ids();

create index if not exists teller_bank_accounts_gl_idx
  on public.teller_bank_accounts (organization_id, gl_account_id)
  where gl_account_id is not null;

-- ---------------------------------------------------------------------------
-- teller_bank_transactions — normalized evidence model
-- ---------------------------------------------------------------------------

alter table public.teller_bank_transactions
  add column if not exists provider_transaction_id text,
  add column if not exists provider_pending_transaction_id text,
  add column if not exists normalized_amount numeric(14, 2),
  add column if not exists direction text,
  add column if not exists transaction_type text,
  add column if not exists description text,
  add column if not exists raw_provider_metadata jsonb not null default '{}'::jsonb,
  add column if not exists status text,
  add column if not exists provider_lifecycle_state text not null default 'active',
  add column if not exists superseded_by_transaction_id uuid
    references public.teller_bank_transactions (id) on delete set null;

comment on column public.teller_bank_transactions.external_transaction_id is
  'Provider transaction id (legacy name; kept in sync with provider_transaction_id).';
comment on column public.teller_bank_transactions.amount is
  'Provider/raw signed amount — never use directly in Teller accounting logic.';
comment on column public.teller_bank_transactions.normalized_amount is
  'Canonical Teller sign: asset bank positive=inflow; credit card liability positive=charge.';
comment on column public.teller_bank_transactions.match_status is
  'Legacy workflow status — kept for backward compatibility; status column is authoritative.';

update public.teller_bank_transactions
set provider_transaction_id = external_transaction_id
where provider_transaction_id is null;

update public.teller_bank_transactions
set description = coalesce(nullif(description, ''), name)
where description is null or description = '';

update public.teller_bank_transactions t
set
  normalized_amount = public.teller_compute_normalized_bank_amount(
    t.amount,
    public.teller_bank_account_gl_kind(t.bank_account_id)
  ),
  direction = public.teller_compute_bank_direction(
    public.teller_compute_normalized_bank_amount(
      t.amount,
      public.teller_bank_account_gl_kind(t.bank_account_id)
    ),
    public.teller_bank_account_gl_kind(t.bank_account_id)
  )
where normalized_amount is null;

update public.teller_bank_transactions
set status = case match_status
  when 'suggested' then 'suggested'
  when 'matched' then 'matched'
  when 'ignored' then 'excluded'
  else 'unreviewed'
end
where status is null;

alter table public.teller_bank_transactions
  alter column normalized_amount set not null,
  alter column status set not null,
  alter column status set default 'unreviewed';

alter table public.teller_bank_transactions
  drop constraint if exists teller_bank_transactions_status_check;

alter table public.teller_bank_transactions
  add constraint teller_bank_transactions_status_check
  check (status in (
    'unreviewed',
    'suggested',
    'partially_matched',
    'matched',
    'categorized',
    'excluded',
    'reconciled'
  ));

alter table public.teller_bank_transactions
  drop constraint if exists teller_bank_transactions_direction_check;

alter table public.teller_bank_transactions
  add constraint teller_bank_transactions_direction_check
  check (direction is null or direction in (
    'inflow', 'outflow', 'charge', 'payment', 'credit_refund'
  ));

alter table public.teller_bank_transactions
  drop constraint if exists teller_bank_transactions_lifecycle_check;

alter table public.teller_bank_transactions
  add constraint teller_bank_transactions_lifecycle_check
  check (provider_lifecycle_state in ('active', 'provider_removed', 'superseded'));

-- Provider identity: scoped to bank account (drop org-only uniqueness if present)
alter table public.teller_bank_transactions
  drop constraint if exists teller_bank_transactions_organization_id_external_transaction_id_key;

drop index if exists public.teller_bank_transactions_provider_identity_idx;
create unique index teller_bank_transactions_provider_identity_idx
  on public.teller_bank_transactions (organization_id, bank_account_id, external_transaction_id);

create index if not exists teller_bank_transactions_pending_lookup_idx
  on public.teller_bank_transactions (organization_id, bank_account_id, provider_pending_transaction_id)
  where provider_pending_transaction_id is not null;

create index if not exists teller_bank_transactions_status_queue_idx
  on public.teller_bank_transactions (organization_id, bank_account_id, status, posted_date desc);

create index if not exists teller_bank_transactions_superseded_idx
  on public.teller_bank_transactions (superseded_by_transaction_id)
  where superseded_by_transaction_id is not null;

create or replace function public.teller_sync_bank_transaction_provider_ids()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if NEW.provider_transaction_id is not null and NEW.external_transaction_id is null then
    NEW.external_transaction_id := NEW.provider_transaction_id;
  elsif NEW.external_transaction_id is not null and NEW.provider_transaction_id is null then
    NEW.provider_transaction_id := NEW.external_transaction_id;
  elsif NEW.provider_transaction_id is not null
    and NEW.external_transaction_id is not null
    and NEW.provider_transaction_id <> NEW.external_transaction_id then
    NEW.external_transaction_id := NEW.provider_transaction_id;
  end if;

  if NEW.description is null or NEW.description = '' then
    NEW.description := coalesce(NEW.name, '');
  end if;

  if TG_OP = 'INSERT'
    or NEW.amount is distinct from OLD.amount
    or NEW.bank_account_id is distinct from OLD.bank_account_id then
    NEW.normalized_amount := public.teller_compute_normalized_bank_amount(
      NEW.amount,
      public.teller_bank_account_gl_kind(NEW.bank_account_id)
    );
    NEW.direction := public.teller_compute_bank_direction(
      NEW.normalized_amount,
      public.teller_bank_account_gl_kind(NEW.bank_account_id)
    );
  end if;

  return NEW;
end;
$$;

drop trigger if exists teller_bank_transactions_provider_sync on public.teller_bank_transactions;
create trigger teller_bank_transactions_provider_sync
  before insert or update on public.teller_bank_transactions
  for each row execute function public.teller_sync_bank_transaction_provider_ids();

create or replace function public.teller_sync_bank_transaction_legacy_match_status()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if NEW.status is distinct from OLD.status then
    NEW.match_status := case NEW.status
      when 'suggested' then 'suggested'
      when 'partially_matched' then 'suggested'
      when 'matched' then 'matched'
      when 'categorized' then 'matched'
      when 'reconciled' then 'matched'
      when 'excluded' then 'ignored'
      else 'unmatched'
    end;
  elsif NEW.match_status is distinct from OLD.match_status
    and NEW.status is not distinct from OLD.status then
    NEW.status := case NEW.match_status
      when 'suggested' then 'suggested'
      when 'matched' then 'matched'
      when 'ignored' then 'excluded'
      else 'unreviewed'
    end;
  end if;

  return NEW;
end;
$$;

drop trigger if exists teller_bank_transactions_legacy_status_sync on public.teller_bank_transactions;
create trigger teller_bank_transactions_legacy_status_sync
  before insert or update on public.teller_bank_transactions
  for each row execute function public.teller_sync_bank_transaction_legacy_match_status();

-- ---------------------------------------------------------------------------
-- teller_bank_matches — authoritative many-to-many match model
-- ---------------------------------------------------------------------------

create table if not exists public.teller_bank_matches (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  bank_transaction_id uuid not null references public.teller_bank_transactions (id) on delete cascade,
  matched_resource_type text not null,
  matched_resource_id uuid not null,
  matched_amount numeric(14, 2) not null,
  status text not null default 'confirmed',
  confidence numeric(5, 2),
  match_method text,
  idempotency_event_id text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  removed_at timestamptz,
  removed_by uuid references auth.users (id) on delete set null,
  constraint teller_bank_matches_amount_positive check (matched_amount > 0),
  constraint teller_bank_matches_status_check check (status in ('suggested', 'confirmed', 'removed')),
  constraint teller_bank_matches_resource_type_check check (matched_resource_type in (
    'customer_payment',
    'bill_payment',
    'expense_payment',
    'customer_deposit',
    'deposit_refund',
    'credit_refund',
    'payment_reversal',
    'bank_transfer',
    'journal_entry',
    'bank_fee',
    'interest_income',
    'interest_expense',
    'owner_contribution',
    'owner_draw',
    'document'
  ))
);

create index if not exists teller_bank_matches_org_txn_idx
  on public.teller_bank_matches (organization_id, bank_transaction_id, status);

create index if not exists teller_bank_matches_resource_idx
  on public.teller_bank_matches (organization_id, matched_resource_type, matched_resource_id, status);

create unique index if not exists teller_bank_matches_idempotency_idx
  on public.teller_bank_matches (organization_id, idempotency_event_id)
  where idempotency_event_id is not null and status = 'confirmed';

create or replace function public.teller_validate_bank_match_org()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_txn_org uuid;
begin
  select organization_id into v_txn_org
  from public.teller_bank_transactions
  where id = NEW.bank_transaction_id;

  if not found then
    raise exception 'Bank transaction % does not exist', NEW.bank_transaction_id;
  end if;

  if v_txn_org <> NEW.organization_id then
    raise exception 'Bank transaction organization mismatch';
  end if;

  return NEW;
end;
$$;

drop trigger if exists teller_bank_matches_org_guard on public.teller_bank_matches;
create trigger teller_bank_matches_org_guard
  before insert or update on public.teller_bank_matches
  for each row execute function public.teller_validate_bank_match_org();

-- Legacy single-match backfill (non-destructive)
insert into public.teller_bank_matches (
  organization_id,
  bank_transaction_id,
  matched_resource_type,
  matched_resource_id,
  matched_amount,
  status,
  match_method,
  confirmed_at,
  created_at
)
select
  t.organization_id,
  t.id,
  'journal_entry',
  t.matched_journal_entry_id,
  abs(coalesce(t.normalized_amount, t.amount)),
  'confirmed',
  'legacy_backfill',
  coalesce(t.updated_at, t.created_at),
  coalesce(t.updated_at, t.created_at)
from public.teller_bank_transactions t
where t.matched_journal_entry_id is not null
  and not exists (
    select 1
    from public.teller_bank_matches m
    where m.bank_transaction_id = t.id
      and m.matched_resource_type = 'journal_entry'
      and m.matched_resource_id = t.matched_journal_entry_id
      and m.status = 'confirmed'
  );

insert into public.teller_bank_matches (
  organization_id,
  bank_transaction_id,
  matched_resource_type,
  matched_resource_id,
  matched_amount,
  status,
  match_method,
  confirmed_at,
  created_at
)
select
  t.organization_id,
  t.id,
  'document',
  t.matched_document_id,
  abs(coalesce(t.normalized_amount, t.amount)),
  'confirmed',
  'legacy_backfill',
  coalesce(t.updated_at, t.created_at),
  coalesce(t.updated_at, t.created_at)
from public.teller_bank_transactions t
where t.matched_document_id is not null
  and not exists (
    select 1
    from public.teller_bank_matches m
    where m.bank_transaction_id = t.id
      and m.matched_resource_type = 'document'
      and m.matched_resource_id = t.matched_document_id
      and m.status = 'confirmed'
  );

-- ---------------------------------------------------------------------------
-- teller_bank_transaction_splits — categorization staging
-- ---------------------------------------------------------------------------

create table if not exists public.teller_bank_transaction_splits (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  bank_transaction_id uuid not null references public.teller_bank_transactions (id) on delete cascade,
  account_id uuid not null references public.teller_accounts (id) on delete restrict,
  party_id uuid references public.teller_parties (id) on delete set null,
  job_id uuid references public.teller_jobs (id) on delete set null,
  amount numeric(14, 2) not null,
  memo text not null default '',
  posted_journal_entry_id uuid references public.teller_journal_entries (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint teller_bank_transaction_splits_amount_positive check (amount > 0)
);

create index if not exists teller_bank_transaction_splits_txn_idx
  on public.teller_bank_transaction_splits (organization_id, bank_transaction_id);

create or replace function public.teller_validate_bank_split_org()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_txn_org uuid;
begin
  select organization_id into v_txn_org
  from public.teller_bank_transactions
  where id = NEW.bank_transaction_id;

  if not found then
    raise exception 'Bank transaction % does not exist', NEW.bank_transaction_id;
  end if;

  if v_txn_org <> NEW.organization_id then
    raise exception 'Bank transaction organization mismatch';
  end if;

  if not exists (
    select 1 from public.teller_accounts a
    where a.id = NEW.account_id
      and a.organization_id = NEW.organization_id
  ) then
    raise exception 'Split account organization mismatch';
  end if;

  return NEW;
end;
$$;

drop trigger if exists teller_bank_transaction_splits_org_guard on public.teller_bank_transaction_splits;
create trigger teller_bank_transaction_splits_org_guard
  before insert or update on public.teller_bank_transaction_splits
  for each row execute function public.teller_validate_bank_split_org();

-- ---------------------------------------------------------------------------
-- teller_bank_transfers — one journal, two feed sides
-- ---------------------------------------------------------------------------

create table if not exists public.teller_bank_transfers (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  source_bank_transaction_id uuid references public.teller_bank_transactions (id) on delete set null,
  destination_bank_transaction_id uuid references public.teller_bank_transactions (id) on delete set null,
  source_bank_account_id uuid not null references public.teller_bank_accounts (id) on delete restrict,
  destination_bank_account_id uuid not null references public.teller_bank_accounts (id) on delete restrict,
  journal_entry_id uuid references public.teller_journal_entries (id) on delete set null,
  amount numeric(14, 2) not null,
  transfer_date date not null,
  status text not null default 'confirmed',
  idempotency_event_id text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint teller_bank_transfers_amount_positive check (amount > 0),
  constraint teller_bank_transfers_status_check check (status in ('pending', 'confirmed', 'void'))
);

create unique index if not exists teller_bank_transfers_idempotency_idx
  on public.teller_bank_transfers (organization_id, idempotency_event_id)
  where idempotency_event_id is not null and status = 'confirmed';

create index if not exists teller_bank_transfers_pair_idx
  on public.teller_bank_transfers (
    organization_id,
    source_bank_account_id,
    destination_bank_account_id,
    transfer_date desc
  );

-- ---------------------------------------------------------------------------
-- teller_bank_reconciliations — book-side statement proof
-- ---------------------------------------------------------------------------

create table if not exists public.teller_bank_reconciliations (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  bank_account_id uuid not null references public.teller_bank_accounts (id) on delete restrict,
  statement_start_date date not null,
  statement_end_date date not null,
  beginning_reconciled_balance numeric(14, 2) not null default 0,
  statement_ending_balance numeric(14, 2) not null,
  status text not null default 'draft',
  started_by uuid references auth.users (id) on delete set null,
  started_at timestamptz,
  completed_by uuid references auth.users (id) on delete set null,
  completed_at timestamptz,
  reopened_by uuid references auth.users (id) on delete set null,
  reopened_at timestamptz,
  reopen_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint teller_bank_reconciliations_dates_check
    check (statement_end_date >= statement_start_date),
  constraint teller_bank_reconciliations_status_check
    check (status in ('draft', 'in_progress', 'completed', 'reopened'))
);

create index if not exists teller_bank_reconciliations_account_idx
  on public.teller_bank_reconciliations (organization_id, bank_account_id, status, statement_end_date desc);

-- ---------------------------------------------------------------------------
-- teller_bank_reconciliation_items — cleared book activity
-- ---------------------------------------------------------------------------

create table if not exists public.teller_bank_reconciliation_items (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  reconciliation_id uuid not null references public.teller_bank_reconciliations (id) on delete cascade,
  journal_entry_id uuid references public.teller_journal_entries (id) on delete restrict,
  journal_line_id uuid references public.teller_journal_lines (id) on delete restrict,
  bank_transaction_id uuid references public.teller_bank_transactions (id) on delete set null,
  cleared_amount numeric(14, 2) not null,
  cleared_date date not null,
  created_at timestamptz not null default now(),
  constraint teller_bank_reconciliation_items_amount_positive check (cleared_amount > 0),
  constraint teller_bank_reconciliation_items_target_check check (
    journal_entry_id is not null
    or journal_line_id is not null
    or bank_transaction_id is not null
  )
);

create index if not exists teller_bank_reconciliation_items_recon_idx
  on public.teller_bank_reconciliation_items (organization_id, reconciliation_id);

create index if not exists teller_bank_reconciliation_items_journal_idx
  on public.teller_bank_reconciliation_items (organization_id, journal_entry_id)
  where journal_entry_id is not null;

create index if not exists teller_bank_reconciliation_items_line_idx
  on public.teller_bank_reconciliation_items (organization_id, journal_line_id)
  where journal_line_id is not null;

create or replace function public.teller_validate_bank_reconciliation_org()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_recon record;
  v_bank_org uuid;
begin
  if TG_TABLE_NAME = 'teller_bank_reconciliations' then
    select organization_id into v_bank_org
    from public.teller_bank_accounts
    where id = NEW.bank_account_id;
    if not found then
      raise exception 'Bank account % does not exist', NEW.bank_account_id;
    end if;
    if v_bank_org <> NEW.organization_id then
      raise exception 'Bank account organization mismatch';
    end if;
    return NEW;
  end if;

  select r.organization_id, r.bank_account_id, r.status
  into v_recon
  from public.teller_bank_reconciliations r
  where r.id = NEW.reconciliation_id;

  if not found then
    raise exception 'Reconciliation % does not exist', NEW.reconciliation_id;
  end if;

  if v_recon.organization_id <> NEW.organization_id then
    raise exception 'Reconciliation organization mismatch';
  end if;

  if NEW.bank_transaction_id is not null then
    select organization_id into v_bank_org
    from public.teller_bank_transactions
    where id = NEW.bank_transaction_id;
    if not found or v_bank_org <> NEW.organization_id then
      raise exception 'Bank transaction organization mismatch';
    end if;
  end if;

  if NEW.journal_entry_id is not null then
    if not exists (
      select 1 from public.teller_journal_entries je
      where je.id = NEW.journal_entry_id
        and je.organization_id = NEW.organization_id
    ) then
      raise exception 'Journal entry organization mismatch';
    end if;
  end if;

  if NEW.journal_line_id is not null then
    if not exists (
      select 1
      from public.teller_journal_lines jl
      join public.teller_journal_entries je on je.id = jl.entry_id
      where jl.id = NEW.journal_line_id
        and je.organization_id = NEW.organization_id
    ) then
      raise exception 'Journal line organization mismatch';
    end if;
  end if;

  return NEW;
end;
$$;

drop trigger if exists teller_bank_reconciliations_org_guard on public.teller_bank_reconciliations;
create trigger teller_bank_reconciliations_org_guard
  before insert or update on public.teller_bank_reconciliations
  for each row execute function public.teller_validate_bank_reconciliation_org();

drop trigger if exists teller_bank_reconciliation_items_org_guard on public.teller_bank_reconciliation_items;
create trigger teller_bank_reconciliation_items_org_guard
  before insert or update on public.teller_bank_reconciliation_items
  for each row execute function public.teller_validate_bank_reconciliation_org();

-- ---------------------------------------------------------------------------
-- teller_bank_import_batches — future CSV/manual import
-- ---------------------------------------------------------------------------

create table if not exists public.teller_bank_import_batches (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  bank_account_id uuid not null references public.teller_bank_accounts (id) on delete cascade,
  source text not null default 'manual_csv',
  filename text,
  mapping jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  row_count integer not null default 0,
  imported_count integer not null default 0,
  duplicate_count integer not null default 0,
  error_message text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint teller_bank_import_batches_status_check
    check (status in ('pending', 'preview', 'importing', 'completed', 'failed', 'cancelled'))
);

create index if not exists teller_bank_import_batches_account_idx
  on public.teller_bank_import_batches (organization_id, bank_account_id, created_at desc);

-- ---------------------------------------------------------------------------
-- RLS — new Phase 5 banking tables
-- ---------------------------------------------------------------------------

alter table public.teller_bank_matches enable row level security;
alter table public.teller_bank_transaction_splits enable row level security;
alter table public.teller_bank_transfers enable row level security;
alter table public.teller_bank_reconciliations enable row level security;
alter table public.teller_bank_reconciliation_items enable row level security;
alter table public.teller_bank_import_batches enable row level security;

create policy "teller members read bank matches"
  on public.teller_bank_matches for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage bank matches"
  on public.teller_bank_matches for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

create policy "teller members read bank transaction splits"
  on public.teller_bank_transaction_splits for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage bank transaction splits"
  on public.teller_bank_transaction_splits for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

create policy "teller members read bank transfers"
  on public.teller_bank_transfers for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage bank transfers"
  on public.teller_bank_transfers for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

create policy "teller members read bank reconciliations"
  on public.teller_bank_reconciliations for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage bank reconciliations"
  on public.teller_bank_reconciliations for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

create policy "teller members read bank reconciliation items"
  on public.teller_bank_reconciliation_items for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage bank reconciliation items"
  on public.teller_bank_reconciliation_items for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

create policy "teller members read bank import batches"
  on public.teller_bank_import_batches for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage bank import batches"
  on public.teller_bank_import_batches for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

comment on table public.teller_bank_matches is
  'Authoritative bank evidence ↔ accounting resource relationships. Legacy FK columns on teller_bank_transactions are non-authoritative.';
comment on table public.teller_bank_reconciliations is
  'Formal bank reconciliation against book activity on the linked GL account; distinct from subledger reconciliation.';
comment on table public.teller_bank_reconciliation_items is
  'Book-side cleared items for a reconciliation period; may reference journal lines/entries and matched bank transactions.';
