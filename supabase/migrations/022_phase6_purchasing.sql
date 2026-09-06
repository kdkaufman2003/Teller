-- Phase 6B: Purchase orders, receiving, recurring bill templates (non-GL operational)

-- Link bills to POs after PO table exists
-- (purchase_order_id column added in 021 without FK until PO table exists)

create table if not exists public.teller_purchase_orders (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  number text not null,
  party_id uuid not null references public.teller_parties (id) on delete restrict,
  job_id uuid references public.teller_jobs (id) on delete set null,
  status text not null default 'draft',
  issue_date date not null default current_date,
  expected_date date,
  ship_to text not null default '',
  buyer_name text not null default '',
  vendor_message text not null default '',
  memo text not null default '',
  subtotal numeric(14, 2) not null default 0,
  tax numeric(14, 2) not null default 0,
  total numeric(14, 2) not null default 0,
  submitted_by uuid references auth.users (id) on delete set null,
  submitted_at timestamptz,
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  rejection_reason text not null default '',
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint teller_purchase_orders_number_org unique (organization_id, number),
  constraint teller_purchase_orders_status_check check (status in (
    'draft',
    'pending_approval',
    'approved',
    'sent',
    'partially_received',
    'received',
    'partially_billed',
    'billed',
    'closed',
    'cancelled'
  ))
);

create index if not exists teller_purchase_orders_org_idx
  on public.teller_purchase_orders (organization_id, status, issue_date desc);

alter table public.teller_documents
  drop constraint if exists teller_documents_purchase_order_id_fkey;

alter table public.teller_documents
  add constraint teller_documents_purchase_order_id_fkey
  foreign key (purchase_order_id) references public.teller_purchase_orders (id) on delete set null;

create table if not exists public.teller_purchase_order_lines (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  purchase_order_id uuid not null references public.teller_purchase_orders (id) on delete cascade,
  description text not null default '',
  quantity numeric(12, 4) not null default 1,
  unit_cost numeric(14, 4) not null default 0,
  amount numeric(14, 2) not null default 0,
  account_id uuid references public.teller_accounts (id) on delete set null,
  job_id uuid references public.teller_jobs (id) on delete set null,
  cost_category text not null default '',
  cost_type text not null default '',
  quantity_received numeric(12, 4) not null default 0,
  quantity_billed numeric(12, 4) not null default 0,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists teller_purchase_order_lines_po_idx
  on public.teller_purchase_order_lines (purchase_order_id, sort_order);

create table if not exists public.teller_purchase_receipts (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  purchase_order_id uuid not null references public.teller_purchase_orders (id) on delete cascade,
  receipt_date date not null default current_date,
  reference_number text not null default '',
  received_by text not null default '',
  location text not null default '',
  memo text not null default '',
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists teller_purchase_receipts_po_idx
  on public.teller_purchase_receipts (organization_id, purchase_order_id);

create table if not exists public.teller_purchase_receipt_lines (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  receipt_id uuid not null references public.teller_purchase_receipts (id) on delete cascade,
  purchase_order_line_id uuid not null references public.teller_purchase_order_lines (id) on delete restrict,
  quantity_received numeric(12, 4) not null,
  created_at timestamptz not null default now(),
  constraint teller_purchase_receipt_lines_qty_positive check (quantity_received > 0)
);

create table if not exists public.teller_recurring_bill_templates (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  name text not null,
  party_id uuid not null references public.teller_parties (id) on delete restrict,
  job_id uuid references public.teller_jobs (id) on delete set null,
  recurrence text not null default 'monthly',
  start_date date not null,
  end_date date,
  issue_day_of_month integer,
  terms text not null default '',
  default_due_days integer,
  memo text not null default '',
  tax numeric(14, 2) not null default 0,
  active boolean not null default true,
  last_generated_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint teller_recurring_bill_templates_recurrence_check check (
    recurrence in ('weekly', 'monthly', 'quarterly', 'yearly')
  )
);

create index if not exists teller_recurring_bill_templates_org_idx
  on public.teller_recurring_bill_templates (organization_id, active);

create table if not exists public.teller_recurring_bill_template_lines (
  id uuid primary key default uuid_generate_v4(),
  template_id uuid not null references public.teller_recurring_bill_templates (id) on delete cascade,
  description text not null default '',
  quantity numeric(12, 2) not null default 1,
  unit_price numeric(14, 2) not null default 0,
  amount numeric(14, 2) not null default 0,
  account_id uuid references public.teller_accounts (id) on delete set null,
  job_id uuid references public.teller_jobs (id) on delete set null,
  cost_category text not null default '',
  cost_type text not null default '',
  sort_order integer not null default 0
);

-- RLS
alter table public.teller_purchase_orders enable row level security;
alter table public.teller_purchase_order_lines enable row level security;
alter table public.teller_purchase_receipts enable row level security;
alter table public.teller_purchase_receipt_lines enable row level security;
alter table public.teller_recurring_bill_templates enable row level security;
alter table public.teller_recurring_bill_template_lines enable row level security;

create policy "teller members read purchase orders"
  on public.teller_purchase_orders for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage purchase orders"
  on public.teller_purchase_orders for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

create policy "teller members read po lines"
  on public.teller_purchase_order_lines for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage po lines"
  on public.teller_purchase_order_lines for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

create policy "teller members read purchase receipts"
  on public.teller_purchase_receipts for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage purchase receipts"
  on public.teller_purchase_receipts for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

create policy "teller members read receipt lines"
  on public.teller_purchase_receipt_lines for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage receipt lines"
  on public.teller_purchase_receipt_lines for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

create policy "teller members read recurring bill templates"
  on public.teller_recurring_bill_templates for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage recurring bill templates"
  on public.teller_recurring_bill_templates for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

create policy "teller members read recurring template lines"
  on public.teller_recurring_bill_template_lines for select
  using (
    exists (
      select 1 from public.teller_recurring_bill_templates t
      where t.id = template_id
        and public.teller_is_org_member(t.organization_id)
    )
  );

create policy "teller writers manage recurring template lines"
  on public.teller_recurring_bill_template_lines for all
  using (
    exists (
      select 1 from public.teller_recurring_bill_templates t
      where t.id = template_id
        and public.teller_is_org_member(t.organization_id)
        and public.teller_can_write_books(t.organization_id)
    )
  )
  with check (
    exists (
      select 1 from public.teller_recurring_bill_templates t
      where t.id = template_id
        and public.teller_is_org_member(t.organization_id)
        and public.teller_can_write_books(t.organization_id)
    )
  );
