-- Phase 7: read-only banking adapter (connections, accounts, transactions, matching)

create table if not exists public.teller_bank_connections (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  provider text not null default 'plaid',
  external_item_id text not null,
  institution_id text,
  institution_name text not null default '',
  status text not null default 'active'
    check (status in ('active', 'error', 'disconnected')),
  last_synced_at timestamptz,
  last_sync_summary jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider, external_item_id)
);

create index if not exists teller_bank_connections_org_idx
  on public.teller_bank_connections (organization_id, status, updated_at desc);

-- Server-only credentials — no RLS policies (deny authenticated access; service role only).
create table if not exists public.teller_bank_connection_secrets (
  connection_id uuid primary key references public.teller_bank_connections (id) on delete cascade,
  access_token text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.teller_bank_accounts (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  connection_id uuid not null references public.teller_bank_connections (id) on delete cascade,
  external_account_id text not null,
  name text not null default '',
  official_name text not null default '',
  mask text,
  account_type text,
  account_subtype text,
  currency text not null default 'USD',
  current_balance numeric(14, 2),
  teller_account_id uuid references public.teller_accounts (id) on delete set null,
  last_synced_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, connection_id, external_account_id)
);

create index if not exists teller_bank_accounts_org_idx
  on public.teller_bank_accounts (organization_id, connection_id);

create table if not exists public.teller_bank_transactions (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  bank_account_id uuid not null references public.teller_bank_accounts (id) on delete cascade,
  external_transaction_id text not null,
  posted_date date not null,
  authorized_date date,
  amount numeric(14, 2) not null,
  name text not null default '',
  merchant_name text,
  pending boolean not null default false,
  category jsonb not null default '[]'::jsonb,
  match_status text not null default 'unmatched'
    check (match_status in ('unmatched', 'suggested', 'matched', 'ignored')),
  matched_journal_entry_id uuid references public.teller_journal_entries (id) on delete set null,
  matched_document_id uuid references public.teller_documents (id) on delete set null,
  match_confidence numeric(5, 2),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, external_transaction_id)
);

create index if not exists teller_bank_transactions_org_idx
  on public.teller_bank_transactions (organization_id, bank_account_id, posted_date desc);

create index if not exists teller_bank_transactions_match_idx
  on public.teller_bank_transactions (organization_id, match_status, posted_date desc);

alter table public.teller_bank_connections enable row level security;
alter table public.teller_bank_connection_secrets enable row level security;
alter table public.teller_bank_accounts enable row level security;
alter table public.teller_bank_transactions enable row level security;

create policy "teller members read bank connections"
  on public.teller_bank_connections for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage bank connections"
  on public.teller_bank_connections for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

create policy "teller members read bank accounts"
  on public.teller_bank_accounts for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage bank accounts"
  on public.teller_bank_accounts for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

create policy "teller members read bank transactions"
  on public.teller_bank_transactions for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage bank transactions"
  on public.teller_bank_transactions for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

comment on table public.teller_bank_connection_secrets is
  'Plaid access tokens — service role only; never expose to client.';
