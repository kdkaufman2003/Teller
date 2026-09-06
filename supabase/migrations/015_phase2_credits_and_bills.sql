-- Phase 2: Credits & Vendor Bills

-- ---------------------------------------------------------------------------
-- teller_documents: expand kinds, statuses, reference fields
-- ---------------------------------------------------------------------------

alter table public.teller_documents
  add column if not exists applies_to_document_id uuid
  references public.teller_documents (id) on delete set null;

alter table public.teller_documents
  add column if not exists reference_number text not null default '';

alter table public.teller_documents
  add column if not exists terms text not null default '';

alter table public.teller_documents
  drop constraint if exists teller_documents_kind_check;

alter table public.teller_documents
  add constraint teller_documents_kind_check
  check (kind in ('invoice', 'bill', 'expense', 'credit_memo', 'vendor_credit'));

alter table public.teller_documents
  drop constraint if exists teller_documents_status_check;

alter table public.teller_documents
  add constraint teller_documents_status_check
  check (status in (
    'draft',
    'open',
    'partially_paid',
    'paid',
    'partially_applied',
    'applied',
    'void'
  ));

create index if not exists teller_documents_applies_to_idx
  on public.teller_documents (organization_id, applies_to_document_id)
  where applies_to_document_id is not null;

-- ---------------------------------------------------------------------------
-- teller_document_allocations — non-cash credit applications
-- ---------------------------------------------------------------------------

create table if not exists public.teller_document_allocations (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  source_document_id uuid not null references public.teller_documents (id) on delete cascade,
  target_document_id uuid not null references public.teller_documents (id) on delete cascade,
  amount numeric(14, 2) not null,
  allocation_kind text not null,
  created_at timestamptz not null default now(),
  constraint teller_document_allocations_amount_positive check (amount > 0),
  constraint teller_document_allocations_kind_check check (allocation_kind in (
    'customer_credit_apply',
    'vendor_credit_apply'
  )),
  unique (source_document_id, target_document_id, allocation_kind)
);

create index if not exists teller_document_allocations_org_source_idx
  on public.teller_document_allocations (organization_id, source_document_id);

create index if not exists teller_document_allocations_org_target_idx
  on public.teller_document_allocations (organization_id, target_document_id);

alter table public.teller_document_allocations enable row level security;

create policy "teller members read document allocations"
  on public.teller_document_allocations for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers insert document allocations"
  on public.teller_document_allocations for insert
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );
