-- Phase 11: intelligence suggestions (human review gate — never auto-posts to GL)

create table if not exists public.teller_intelligence_suggestions (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  kind text not null check (kind in ('categorization', 'reconciliation', 'anomaly', 'insight')),
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'dismissed')),
  fingerprint text not null,
  title text not null,
  description text not null,
  confidence numeric(5, 2),
  href text,
  payload jsonb not null default '{}'::jsonb,
  resource_kind text,
  resource_id uuid,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users (id) on delete set null,
  unique (organization_id, fingerprint)
);

create index if not exists teller_intelligence_suggestions_org_idx
  on public.teller_intelligence_suggestions (organization_id, status, created_at desc);

alter table public.teller_intelligence_suggestions enable row level security;

create policy "teller members read intelligence suggestions"
  on public.teller_intelligence_suggestions for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage intelligence suggestions"
  on public.teller_intelligence_suggestions for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );
