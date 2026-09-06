-- Phase 1: Document & Subledger Foundation
-- Payment allocations, document-journal links, payment event fields

-- ---------------------------------------------------------------------------
-- teller_payments: future-safe payment event fields
-- ---------------------------------------------------------------------------

alter table public.teller_payments
  add column if not exists payment_type text not null default 'customer_payment';

alter table public.teller_payments
  drop constraint if exists teller_payments_payment_type_check;

alter table public.teller_payments
  add constraint teller_payments_payment_type_check
  check (payment_type in (
    'customer_payment',
    'customer_deposit',
    'customer_refund',
    'bill_payment',
    'vendor_refund'
  ));

alter table public.teller_payments
  add column if not exists status text not null default 'posted';

alter table public.teller_payments
  drop constraint if exists teller_payments_status_check;

alter table public.teller_payments
  add constraint teller_payments_status_check
  check (status in ('posted', 'void'));

alter table public.teller_payments
  add column if not exists payment_method text;

alter table public.teller_payments
  add column if not exists reference_number text;

alter table public.teller_payments
  add column if not exists voided_at timestamptz;

alter table public.teller_payments
  add column if not exists void_journal_entry_id uuid
  references public.teller_journal_entries (id) on delete set null;

alter table public.teller_payments
  add column if not exists void_reason text;

alter table public.teller_payments
  drop constraint if exists teller_payments_amount_positive;

alter table public.teller_payments
  add constraint teller_payments_amount_positive
  check (amount > 0);

create unique index if not exists teller_payments_journal_entry_idx
  on public.teller_payments (organization_id, journal_entry_id)
  where journal_entry_id is not null;

create index if not exists teller_payments_org_status_idx
  on public.teller_payments (organization_id, status, payment_date desc);

-- Classify existing AP-side payments where linked to expense documents
update public.teller_payments p
set payment_type = 'bill_payment'
from public.teller_documents d
where p.document_id = d.id
  and d.kind = 'expense'
  and p.payment_type = 'customer_payment';

-- ---------------------------------------------------------------------------
-- teller_payment_allocations
-- ---------------------------------------------------------------------------

create table if not exists public.teller_payment_allocations (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  payment_id uuid not null references public.teller_payments (id) on delete cascade,
  document_id uuid not null references public.teller_documents (id) on delete cascade,
  amount numeric(14, 2) not null,
  allocation_kind text not null,
  created_at timestamptz not null default now(),
  constraint teller_payment_allocations_amount_positive check (amount > 0),
  constraint teller_payment_allocations_kind_check check (allocation_kind in (
    'invoice_payment',
    'bill_payment',
    'deposit_apply',
    'credit_apply',
    'vendor_credit_apply',
    'refund_offset'
  ))
);

create unique index if not exists teller_payment_allocations_payment_doc_kind_idx
  on public.teller_payment_allocations (payment_id, document_id, allocation_kind);

create index if not exists teller_payment_allocations_org_doc_idx
  on public.teller_payment_allocations (organization_id, document_id);

create index if not exists teller_payment_allocations_org_payment_idx
  on public.teller_payment_allocations (organization_id, payment_id);

alter table public.teller_payment_allocations enable row level security;

create policy "teller members read payment allocations"
  on public.teller_payment_allocations for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers insert payment allocations"
  on public.teller_payment_allocations for insert
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- teller_document_journal_links
-- ---------------------------------------------------------------------------

create table if not exists public.teller_document_journal_links (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  document_id uuid not null references public.teller_documents (id) on delete cascade,
  journal_entry_id uuid not null references public.teller_journal_entries (id) on delete cascade,
  link_kind text not null,
  payment_id uuid references public.teller_payments (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint teller_document_journal_links_kind_check check (link_kind in (
    'accrual',
    'payment',
    'fee',
    'credit',
    'refund',
    'writeoff',
    'reversal',
    'adjustment'
  )),
  unique (document_id, journal_entry_id)
);

create index if not exists teller_document_journal_links_org_doc_idx
  on public.teller_document_journal_links (organization_id, document_id);

create index if not exists teller_document_journal_links_org_journal_idx
  on public.teller_document_journal_links (organization_id, journal_entry_id);

create index if not exists teller_journal_entries_source_idx
  on public.teller_journal_entries (organization_id, source_id, source_kind)
  where source_id is not null;

alter table public.teller_document_journal_links enable row level security;

create policy "teller members read document journal links"
  on public.teller_document_journal_links for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers insert document journal links"
  on public.teller_document_journal_links for insert
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );
