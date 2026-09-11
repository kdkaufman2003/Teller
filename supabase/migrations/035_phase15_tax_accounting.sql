-- Phase 15A: Sales & use tax accounting foundation (additive)
-- Operator applies manually. Does NOT modify teller_post_journal or post journals.

-- ---------------------------------------------------------------------------
-- Extend global jurisdiction reference (Phase 6 engine)
-- ---------------------------------------------------------------------------

alter table public.teller_tax_jurisdictions
  add column if not exists parent_jurisdiction_key text
    references public.teller_tax_jurisdictions (jurisdiction_key) on delete restrict,
  add column if not exists jurisdiction_type text not null default 'state'
    check (jurisdiction_type in ('country', 'state', 'county', 'city', 'district')),
  add column if not exists updated_at timestamptz not null default now();

create index if not exists teller_tax_jurisdictions_parent_idx
  on public.teller_tax_jurisdictions (parent_jurisdiction_key);

create index if not exists teller_tax_jurisdictions_type_state_idx
  on public.teller_tax_jurisdictions (jurisdiction_type, state, county, city);

-- ---------------------------------------------------------------------------
-- Tax authorities (global reference — who receives liability)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_tax_authorities (
  id uuid primary key default uuid_generate_v4(),
  authority_key text not null unique,
  name text not null,
  jurisdiction_key text not null
    references public.teller_tax_jurisdictions (jurisdiction_key) on delete restrict,
  admin_level text not null default 'state'
    check (admin_level in ('state', 'county', 'city', 'district', 'combined')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists teller_tax_authorities_jurisdiction_idx
  on public.teller_tax_authorities (jurisdiction_key);

alter table public.teller_tax_authorities enable row level security;

create policy "authenticated read tax authorities"
  on public.teller_tax_authorities for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Composable rate components (reference rates from rule packs)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_tax_rate_components (
  id uuid primary key default uuid_generate_v4(),
  rate_id uuid not null references public.teller_tax_rates (id) on delete cascade,
  component_type text not null
    check (component_type in ('state', 'county', 'city', 'district', 'other')),
  jurisdiction_key text not null
    references public.teller_tax_jurisdictions (jurisdiction_key) on delete restrict,
  authority_id uuid references public.teller_tax_authorities (id) on delete set null,
  rate_percent numeric(8, 5) not null check (rate_percent >= 0),
  effective_from date not null,
  effective_to date,
  source_citation text not null default '',
  created_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from)
);

create index if not exists teller_tax_rate_components_rate_idx
  on public.teller_tax_rate_components (rate_id, effective_from desc);

create index if not exists teller_tax_rate_components_jurisdiction_idx
  on public.teller_tax_rate_components (jurisdiction_key, effective_from desc);

alter table public.teller_tax_rate_components enable row level security;

create policy "authenticated read tax rate components"
  on public.teller_tax_rate_components for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Organization tax accounting settings
-- ---------------------------------------------------------------------------

create table if not exists public.teller_tax_settings (
  organization_id uuid primary key references public.teller_organizations (id) on delete cascade,
  sales_tax_payable_account_id uuid references public.teller_accounts (id) on delete set null,
  use_tax_expense_account_id uuid references public.teller_accounts (id) on delete set null,
  rounding_policy text not null default 'per_line'
    check (rounding_policy in ('per_line', 'per_component', 'per_document')),
  setup_status text not null default 'not_configured'
    check (setup_status in ('not_configured', 'needs_review', 'configured')),
  tax_inclusive_supported boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id)
);

alter table public.teller_tax_settings enable row level security;

create policy "teller members read tax settings"
  on public.teller_tax_settings for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage tax settings"
  on public.teller_tax_settings for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Tax registrations (org collects in jurisdiction/authority)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_tax_registrations (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  authority_id uuid references public.teller_tax_authorities (id) on delete restrict,
  jurisdiction_key text references public.teller_tax_jurisdictions (jurisdiction_key) on delete restrict,
  registration_number text,
  filing_frequency text not null default 'monthly'
    check (filing_frequency in ('monthly', 'quarterly', 'annual', 'other')),
  status text not null default 'pending'
    check (status in ('active', 'inactive', 'pending')),
  effective_from date not null,
  effective_to date,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from),
  check (authority_id is not null or jurisdiction_key is not null)
);

create index if not exists teller_tax_registrations_org_status_idx
  on public.teller_tax_registrations (organization_id, status, effective_from desc);

alter table public.teller_tax_registrations enable row level security;

create policy "teller members read tax registrations"
  on public.teller_tax_registrations for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage tax registrations"
  on public.teller_tax_registrations for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Tax categories (reference + organization)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_tax_categories (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid references public.teller_organizations (id) on delete cascade,
  scope text not null default 'organization'
    check (scope in ('reference', 'organization')),
  category_key text not null,
  name text not null,
  description text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (scope = 'reference' and organization_id is null)
    or (scope = 'organization' and organization_id is not null)
  )
);

create unique index if not exists teller_tax_categories_ref_key_idx
  on public.teller_tax_categories (category_key)
  where scope = 'reference';

create unique index if not exists teller_tax_categories_org_key_idx
  on public.teller_tax_categories (organization_id, category_key)
  where scope = 'organization';

alter table public.teller_tax_categories enable row level security;

create policy "authenticated read reference tax categories"
  on public.teller_tax_categories for select
  using (scope = 'reference' or public.teller_is_org_member(organization_id));

create policy "teller writers manage org tax categories"
  on public.teller_tax_categories for all
  using (
    scope = 'organization'
    and public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    scope = 'organization'
    and public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Organization taxability rules (effective-dated overrides)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_taxability_rules (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  jurisdiction_key text not null
    references public.teller_tax_jurisdictions (jurisdiction_key) on delete restrict,
  tax_category_key text not null,
  treatment text not null
    check (treatment in ('taxable', 'non_taxable', 'exempt', 'needs_review')),
  priority int not null default 100 check (priority >= 0),
  effective_from date not null,
  effective_to date,
  source_kind text not null default 'organization_override'
    check (source_kind in ('organization_override', 'industry_profile', 'reference_rule_set')),
  rule_set_slug text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from)
);

create index if not exists teller_taxability_rules_org_lookup_idx
  on public.teller_taxability_rules (
    organization_id,
    jurisdiction_key,
    tax_category_key,
    effective_from desc
  );

alter table public.teller_taxability_rules enable row level security;

create policy "teller members read taxability rules"
  on public.teller_taxability_rules for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage taxability rules"
  on public.teller_taxability_rules for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Exemption foundation (15C expands workflow)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_tax_exemptions (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  party_id uuid references public.teller_parties (id) on delete cascade,
  certificate_number text,
  certificate_on_file boolean not null default false,
  jurisdiction_scope jsonb not null default '[]'::jsonb,
  category_scope jsonb not null default '[]'::jsonb,
  status text not null default 'active'
    check (status in ('active', 'inactive', 'pending', 'expired')),
  effective_from date not null,
  effective_to date,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from)
);

create index if not exists teller_tax_exemptions_org_party_idx
  on public.teller_tax_exemptions (organization_id, party_id, status);

alter table public.teller_tax_exemptions enable row level security;

create policy "teller members read tax exemptions"
  on public.teller_tax_exemptions for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage tax exemptions"
  on public.teller_tax_exemptions for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Tax subledger transactions
-- ---------------------------------------------------------------------------

create table if not exists public.teller_tax_transactions (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  transaction_type text not null
    check (transaction_type in (
      'sales_tax_collected',
      'sales_tax_reversed',
      'sales_tax_refunded',
      'use_tax_accrued',
      'tax_adjustment',
      'authority_payment'
    )),
  source_type text not null
    check (source_type in (
      'invoice',
      'credit_memo',
      'refund',
      'bill',
      'vendor_credit',
      'manual_adjustment',
      'authority_payment',
      'other'
    )),
  source_id uuid,
  document_id uuid references public.teller_documents (id) on delete set null,
  line_id uuid references public.teller_document_lines (id) on delete set null,
  determination_status text not null
    check (determination_status in ('resolved', 'exempt', 'non_taxable', 'needs_review', 'override')),
  transaction_date date not null,
  taxable_basis numeric(14, 2) not null default 0,
  tax_amount numeric(14, 2) not null default 0,
  primary_jurisdiction_key text
    references public.teller_tax_jurisdictions (jurisdiction_key) on delete restrict,
  rule_set_slug text,
  rule_key text,
  is_posted boolean not null default false,
  posted_at timestamptz,
  posted_journal_entry_id uuid references public.teller_journal_entries (id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (posted_at is null or is_posted = true)
);

create index if not exists teller_tax_transactions_org_date_idx
  on public.teller_tax_transactions (organization_id, transaction_date desc);

create index if not exists teller_tax_transactions_source_idx
  on public.teller_tax_transactions (organization_id, source_type, source_id);

alter table public.teller_tax_transactions enable row level security;

create policy "teller members read tax transactions"
  on public.teller_tax_transactions for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers insert tax transactions"
  on public.teller_tax_transactions for insert
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

create policy "teller writers update unposted tax transactions"
  on public.teller_tax_transactions for update
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
    and is_posted = false
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Tax transaction component detail
-- ---------------------------------------------------------------------------

create table if not exists public.teller_tax_transaction_components (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  tax_transaction_id uuid not null references public.teller_tax_transactions (id) on delete cascade,
  component_type text not null
    check (component_type in ('state', 'county', 'city', 'district', 'other')),
  jurisdiction_key text not null
    references public.teller_tax_jurisdictions (jurisdiction_key) on delete restrict,
  authority_id uuid references public.teller_tax_authorities (id) on delete set null,
  rate_percent numeric(8, 5) not null default 0 check (rate_percent >= 0),
  taxable_basis numeric(14, 2) not null default 0,
  tax_amount numeric(14, 2) not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists teller_tax_tx_components_tx_idx
  on public.teller_tax_transaction_components (tax_transaction_id);

alter table public.teller_tax_transaction_components enable row level security;

create policy "teller members read tax transaction components"
  on public.teller_tax_transaction_components for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers insert tax transaction components"
  on public.teller_tax_transaction_components for insert
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Immutable posted determination snapshots
-- ---------------------------------------------------------------------------

create table if not exists public.teller_tax_determination_snapshots (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  document_id uuid references public.teller_documents (id) on delete set null,
  line_id uuid references public.teller_document_lines (id) on delete set null,
  tax_transaction_id uuid references public.teller_tax_transactions (id) on delete set null,
  snapshot_at timestamptz not null default now(),
  transaction_date date not null,
  tax_category_key text,
  jurisdiction_key text,
  determination_status text not null
    check (determination_status in ('resolved', 'exempt', 'non_taxable', 'needs_review', 'override')),
  taxable_basis numeric(14, 2) not null default 0,
  tax_amount numeric(14, 2) not null default 0,
  rate_percent numeric(8, 5),
  rule_set_slug text,
  rule_key text,
  exemption_id uuid references public.teller_tax_exemptions (id) on delete set null,
  components jsonb not null default '[]'::jsonb,
  precedence_trace jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists teller_tax_det_snapshots_doc_idx
  on public.teller_tax_determination_snapshots (organization_id, document_id, line_id);

alter table public.teller_tax_determination_snapshots enable row level security;

create policy "teller members read tax determination snapshots"
  on public.teller_tax_determination_snapshots for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers insert tax determination snapshots"
  on public.teller_tax_determination_snapshots for insert
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Tax configuration audit events
-- ---------------------------------------------------------------------------

create table if not exists public.teller_tax_audit_events (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  event_type text not null,
  entity_type text not null,
  entity_id uuid,
  payload jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

create index if not exists teller_tax_audit_events_org_created_idx
  on public.teller_tax_audit_events (organization_id, created_at desc);

alter table public.teller_tax_audit_events enable row level security;

create policy "teller members read tax audit events"
  on public.teller_tax_audit_events for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers insert tax audit events"
  on public.teller_tax_audit_events for insert
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Cross-org integrity guards
-- ---------------------------------------------------------------------------

create or replace function public.teller_guard_tax_settings_org()
returns trigger
language plpgsql
as $$
declare
  acct_org uuid;
begin
  if new.sales_tax_payable_account_id is not null then
    select organization_id into acct_org from public.teller_accounts where id = new.sales_tax_payable_account_id;
    if acct_org is distinct from new.organization_id then
      raise exception 'Sales tax payable account must belong to organization';
    end if;
  end if;
  if new.use_tax_expense_account_id is not null then
    select organization_id into acct_org from public.teller_accounts where id = new.use_tax_expense_account_id;
    if acct_org is distinct from new.organization_id then
      raise exception 'Use tax expense account must belong to organization';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists teller_tax_settings_org_guard on public.teller_tax_settings;
create trigger teller_tax_settings_org_guard
  before insert or update on public.teller_tax_settings
  for each row execute function public.teller_guard_tax_settings_org();

create or replace function public.teller_guard_tax_exemption_org()
returns trigger
language plpgsql
as $$
declare
  party_org uuid;
begin
  if new.party_id is not null then
    select organization_id into party_org from public.teller_parties where id = new.party_id;
    if party_org is distinct from new.organization_id then
      raise exception 'Exemption party must belong to organization';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists teller_tax_exemptions_org_guard on public.teller_tax_exemptions;
create trigger teller_tax_exemptions_org_guard
  before insert or update on public.teller_tax_exemptions
  for each row execute function public.teller_guard_tax_exemption_org();

create or replace function public.teller_guard_tax_transaction_org()
returns trigger
language plpgsql
as $$
declare
  doc_org uuid;
  line_org uuid;
begin
  if new.document_id is not null then
    select organization_id into doc_org from public.teller_documents where id = new.document_id;
    if doc_org is distinct from new.organization_id then
      raise exception 'Tax transaction document must belong to organization';
    end if;
  end if;
  if new.line_id is not null then
    select organization_id into line_org from public.teller_document_lines where id = new.line_id;
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
  return new;
end;
$$;

drop trigger if exists teller_tax_transactions_org_guard on public.teller_tax_transactions;
create trigger teller_tax_transactions_org_guard
  before insert or update on public.teller_tax_transactions
  for each row execute function public.teller_guard_tax_transaction_org();

create or replace function public.teller_guard_tax_tx_component_org()
returns trigger
language plpgsql
as $$
declare
  tx_org uuid;
begin
  select organization_id into tx_org from public.teller_tax_transactions where id = new.tax_transaction_id;
  if tx_org is distinct from new.organization_id then
    raise exception 'Tax transaction component organization mismatch';
  end if;
  return new;
end;
$$;

drop trigger if exists teller_tax_tx_components_org_guard on public.teller_tax_transaction_components;
create trigger teller_tax_tx_components_org_guard
  before insert or update on public.teller_tax_transaction_components
  for each row execute function public.teller_guard_tax_tx_component_org();

-- ---------------------------------------------------------------------------
-- Posted tax immutability
-- ---------------------------------------------------------------------------

create or replace function public.teller_guard_posted_tax_transaction()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and old.is_posted = true then
    raise exception 'Posted tax transactions are immutable';
  end if;
  if tg_op = 'DELETE' and old.is_posted = true then
    raise exception 'Posted tax transactions cannot be deleted';
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists teller_tax_transactions_posted_guard on public.teller_tax_transactions;
create trigger teller_tax_transactions_posted_guard
  before update or delete on public.teller_tax_transactions
  for each row execute function public.teller_guard_posted_tax_transaction();

create or replace function public.teller_guard_tax_determination_snapshot_immutable()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'Tax determination snapshots are immutable';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Tax determination snapshots cannot be deleted';
  end if;
  return old;
end;
$$;

drop trigger if exists teller_tax_det_snapshots_immutable on public.teller_tax_determination_snapshots;
create trigger teller_tax_det_snapshots_immutable
  before update or delete on public.teller_tax_determination_snapshots
  for each row execute function public.teller_guard_tax_determination_snapshot_immutable();
