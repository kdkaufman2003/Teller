-- Phase 6: jurisdiction tax engine (rules loaded from external spec — not hard-coded in app)

create table if not exists public.teller_tax_rule_sets (
  id uuid primary key default uuid_generate_v4(),
  slug text not null unique,
  name text not null,
  version text not null,
  status text not null default 'draft'
    check (status in ('draft', 'reviewed', 'active', 'retired')),
  effective_from date not null,
  effective_to date,
  source_documentation text not null default '',
  spec_hash text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists teller_tax_rule_sets_status_idx
  on public.teller_tax_rule_sets (status, effective_from desc);

comment on table public.teller_tax_rule_sets is
  'Versioned tax rule packs loaded from tax-rules/ spec files after professional review.';

create table if not exists public.teller_tax_jurisdictions (
  id uuid primary key default uuid_generate_v4(),
  jurisdiction_key text not null unique,
  name text not null,
  country text not null default 'US',
  state text,
  county text,
  city text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.teller_tax_rates (
  id uuid primary key default uuid_generate_v4(),
  rule_set_id uuid not null references public.teller_tax_rule_sets (id) on delete cascade,
  jurisdiction_key text not null references public.teller_tax_jurisdictions (jurisdiction_key) on delete restrict,
  rate_percent numeric(8, 5) not null,
  rate_type text not null default 'sales_tax',
  effective_from date not null,
  effective_to date,
  source_citation text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists teller_tax_rates_lookup_idx
  on public.teller_tax_rates (jurisdiction_key, effective_from desc);

create table if not exists public.teller_tax_rules (
  id uuid primary key default uuid_generate_v4(),
  rule_set_id uuid not null references public.teller_tax_rule_sets (id) on delete cascade,
  rule_key text not null,
  priority integer not null default 100,
  conditions jsonb not null default '{}'::jsonb,
  action jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (rule_set_id, rule_key)
);

create index if not exists teller_tax_rules_set_priority_idx
  on public.teller_tax_rules (rule_set_id, priority asc);

create table if not exists public.teller_tax_determinations (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  document_id uuid references public.teller_documents (id) on delete cascade,
  line_id uuid references public.teller_document_lines (id) on delete cascade,
  rule_set_slug text,
  rule_key text,
  jurisdiction_key text,
  tax_treatment text not null,
  taxable_amount numeric(14, 2) not null default 0,
  rate_percent numeric(8, 5),
  tax_amount numeric(14, 2) not null default 0,
  explanation jsonb not null default '{}'::jsonb,
  review_status text not null default 'auto'
    check (review_status in ('auto', 'pending_review', 'confirmed', 'overridden')),
  manual_override boolean not null default false,
  override_reason text,
  created_at timestamptz not null default now()
);

create index if not exists teller_tax_determinations_doc_idx
  on public.teller_tax_determinations (organization_id, document_id, line_id);

alter table public.teller_tax_rule_sets enable row level security;
alter table public.teller_tax_jurisdictions enable row level security;
alter table public.teller_tax_rates enable row level security;
alter table public.teller_tax_rules enable row level security;
alter table public.teller_tax_determinations enable row level security;

-- Global reference data: any signed-in user may read loaded rule packs.
create policy "authenticated read tax rule sets"
  on public.teller_tax_rule_sets for select to authenticated using (true);

create policy "authenticated read tax jurisdictions"
  on public.teller_tax_jurisdictions for select to authenticated using (true);

create policy "authenticated read tax rates"
  on public.teller_tax_rates for select to authenticated using (true);

create policy "authenticated read tax rules"
  on public.teller_tax_rules for select to authenticated using (true);

create policy "teller members read tax determinations"
  on public.teller_tax_determinations for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers insert tax determinations"
  on public.teller_tax_determinations for insert
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

create policy "teller writers update tax determinations"
  on public.teller_tax_determinations for update
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );
