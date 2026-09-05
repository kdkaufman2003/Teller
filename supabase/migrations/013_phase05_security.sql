-- Phase 0.5: HFAC webhook event dedup + integration mapping index

create table if not exists public.teller_hfac_webhook_events (
  event_id text primary key,
  organization_id uuid references public.teller_organizations (id) on delete set null,
  route text not null default '',
  auth_mode text not null default 'hmac',
  received_at timestamptz not null default now()
);

create index if not exists teller_hfac_webhook_events_received_idx
  on public.teller_hfac_webhook_events (received_at desc);

create index if not exists teller_integrations_hfac_external_idx
  on public.teller_integrations ((config->>'external_account_id'))
  where provider in ('hfac', 'hasslefreeac') and enabled = true;

alter table public.teller_hfac_webhook_events enable row level security;

-- No member policies: service role writes via webhook handler only.
