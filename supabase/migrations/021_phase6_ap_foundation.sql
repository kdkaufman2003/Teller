-- Phase 6A: AP foundation — vendor profiles, job-cost line metadata, bill approval, AP settings

-- ---------------------------------------------------------------------------
-- Vendor profile fields on teller_parties
-- ---------------------------------------------------------------------------

alter table public.teller_parties
  add column if not exists legal_name text not null default '',
  add column if not exists party_status text not null default 'active',
  add column if not exists vendor_category text not null default '',
  add column if not exists website text not null default '',
  add column if not exists billing_address_line1 text not null default '',
  add column if not exists billing_address_line2 text not null default '',
  add column if not exists billing_city text not null default '',
  add column if not exists billing_state text not null default '',
  add column if not exists billing_postal text not null default '',
  add column if not exists billing_country text not null default 'US',
  add column if not exists account_number text not null default '',
  add column if not exists default_expense_account_id uuid references public.teller_accounts (id) on delete set null,
  add column if not exists default_cogs_account_id uuid references public.teller_accounts (id) on delete set null,
  add column if not exists payment_terms text not null default '',
  add column if not exists default_due_days integer,
  add column if not exists preferred_payment_method text not null default '',
  add column if not exists eligible_1099 boolean not null default false,
  add column if not exists form_1099_category text not null default '',
  add column if not exists w9_received boolean not null default false,
  add column if not exists w9_received_at date,
  add column if not exists vendor_metadata jsonb not null default '{}'::jsonb;

alter table public.teller_parties
  drop constraint if exists teller_parties_party_status_check;

alter table public.teller_parties
  add constraint teller_parties_party_status_check
  check (party_status in ('active', 'inactive'));

comment on column public.teller_parties.vendor_metadata is
  'Restricted vendor metadata (e.g. tax id references). Do not expose broadly in UI.';

-- ---------------------------------------------------------------------------
-- Document line job-cost hooks
-- ---------------------------------------------------------------------------

alter table public.teller_document_lines
  add column if not exists job_id uuid references public.teller_jobs (id) on delete set null,
  add column if not exists cost_category text not null default '',
  add column if not exists cost_type text not null default '';

alter table public.teller_document_lines
  drop constraint if exists teller_document_lines_cost_type_check;

alter table public.teller_document_lines
  add constraint teller_document_lines_cost_type_check
  check (
    cost_type = ''
    or cost_type in (
      'material',
      'equipment',
      'subcontractor',
      'labor_external',
      'permit',
      'freight',
      'rental',
      'other'
    )
  );

create index if not exists teller_document_lines_job_idx
  on public.teller_document_lines (job_id)
  where job_id is not null;

-- ---------------------------------------------------------------------------
-- Bill approval + PO link on documents
-- ---------------------------------------------------------------------------

alter table public.teller_documents
  add column if not exists purchase_order_id uuid,
  add column if not exists submitted_by uuid references auth.users (id) on delete set null,
  add column if not exists submitted_at timestamptz,
  add column if not exists approved_by uuid references auth.users (id) on delete set null,
  add column if not exists approved_at timestamptz,
  add column if not exists rejection_reason text not null default '';

alter table public.teller_documents
  drop constraint if exists teller_documents_status_check;

alter table public.teller_documents
  add constraint teller_documents_status_check
  check (status in (
    'draft',
    'pending_approval',
    'open',
    'partially_paid',
    'paid',
    'partially_applied',
    'applied',
    'void'
  ));

create index if not exists teller_documents_ap_aging_idx
  on public.teller_documents (organization_id, kind, status, due_date)
  where kind in ('bill', 'expense') and status in ('open', 'partially_paid');

create index if not exists teller_documents_vendor_invoice_idx
  on public.teller_documents (organization_id, party_id, reference_number)
  where kind = 'bill' and reference_number <> '';

comment on column public.teller_documents.attachment_path is
  'Secure storage path for bill/expense attachments (not inline binary).';

-- ---------------------------------------------------------------------------
-- Organization AP settings (approval thresholds)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_ap_settings (
  organization_id uuid primary key references public.teller_organizations (id) on delete cascade,
  require_bill_approval boolean not null default false,
  bill_approval_threshold numeric(14, 2),
  require_po_approval boolean not null default false,
  po_approval_threshold numeric(14, 2),
  default_cost_categories jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.teller_ap_settings enable row level security;

create policy "teller members read ap settings"
  on public.teller_ap_settings for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage ap settings"
  on public.teller_ap_settings for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );
