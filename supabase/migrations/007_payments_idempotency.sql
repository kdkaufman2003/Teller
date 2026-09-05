-- Phase 5: payments entity, integration idempotency, job metadata

alter table public.teller_jobs
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create table if not exists public.teller_payments (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  document_id uuid references public.teller_documents (id) on delete set null,
  party_id uuid references public.teller_parties (id) on delete set null,
  job_id uuid references public.teller_jobs (id) on delete set null,
  amount numeric(14, 2) not null,
  fee_amount numeric(14, 2) not null default 0,
  net_amount numeric(14, 2),
  payment_date date not null default current_date,
  processor text,
  external_source text,
  external_id text,
  journal_entry_id uuid references public.teller_journal_entries (id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists teller_payments_external_idx
  on public.teller_payments (organization_id, external_source, external_id)
  where external_source is not null and external_id is not null;

create index if not exists teller_payments_org_doc_idx
  on public.teller_payments (organization_id, document_id, payment_date desc);

create table if not exists public.teller_integration_events (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  provider text not null,
  event_kind text not null,
  idempotency_key text not null,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (organization_id, provider, idempotency_key)
);

create index if not exists teller_integration_events_org_idx
  on public.teller_integration_events (organization_id, provider, created_at desc);

alter table public.teller_payments enable row level security;
alter table public.teller_integration_events enable row level security;

create policy "teller members read payments"
  on public.teller_payments for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers insert payments"
  on public.teller_payments for insert
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

create policy "teller members read integration events"
  on public.teller_integration_events for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers insert integration events"
  on public.teller_integration_events for insert
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );
