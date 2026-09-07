-- Phase 10: Financial reporting metadata (additive, Phase 9 compatible)
-- Local only — do not apply to production until Phase 10 acceptance.

-- ---------------------------------------------------------------------------
-- Cash flow classification on accounts (optional override; heuristics remain)
-- ---------------------------------------------------------------------------

alter table public.teller_accounts
  add column if not exists cash_flow_category text;

alter table public.teller_accounts
  drop constraint if exists teller_accounts_cash_flow_category_check;

alter table public.teller_accounts
  add constraint teller_accounts_cash_flow_category_check
  check (
    cash_flow_category is null
    or cash_flow_category in (
      'operating',
      'investing',
      'financing',
      'non_cash',
      'transfer',
      'unclassified'
    )
  );

comment on column public.teller_accounts.cash_flow_category is
  'Optional cash flow statement classification override for indirect method reporting.';

-- Default heuristics for common subtypes (idempotent updates)
update public.teller_accounts
set cash_flow_category = 'operating'
where cash_flow_category is null
  and subtype in ('receivable', 'payable', 'prepaid', 'accrued', 'deposit');

update public.teller_accounts
set cash_flow_category = 'financing'
where cash_flow_category is null
  and (
    subtype in ('owner_equity', 'owner_draw', 'owner_contribution')
    or code in ('3000', '3100', '3200', '3900')
  );

update public.teller_accounts
set cash_flow_category = 'investing'
where cash_flow_category is null
  and subtype in ('fixed_asset', 'accumulated_depreciation');

update public.teller_accounts
set cash_flow_category = 'transfer'
where cash_flow_category is null
  and subtype = 'bank';

-- ---------------------------------------------------------------------------
-- Financial statement presentation groups (presentation ≠ GL account)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_report_line_groups (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  statement text not null,
  section text not null,
  label text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  constraint teller_report_line_groups_statement_check
    check (statement in ('profit_and_loss', 'balance_sheet', 'cash_flow')),
  unique (organization_id, statement, section, label)
);

create index if not exists teller_report_line_groups_org_statement_idx
  on public.teller_report_line_groups (organization_id, statement, sort_order);

create table if not exists public.teller_account_report_mappings (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  account_id uuid not null references public.teller_accounts (id) on delete cascade,
  group_id uuid not null references public.teller_report_line_groups (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (organization_id, account_id, group_id)
);

create index if not exists teller_account_report_mappings_org_idx
  on public.teller_account_report_mappings (organization_id, account_id);

alter table public.teller_report_line_groups enable row level security;
alter table public.teller_account_report_mappings enable row level security;

create policy "teller members read report line groups"
  on public.teller_report_line_groups for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage report line groups"
  on public.teller_report_line_groups for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

create policy "teller members read account report mappings"
  on public.teller_account_report_mappings for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage account report mappings"
  on public.teller_account_report_mappings for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Optional GL aggregation RPC for report performance
-- ---------------------------------------------------------------------------

create or replace function public.teller_gl_account_totals(
  p_organization_id uuid,
  p_period_start date,
  p_period_end date
)
returns table (
  account_id uuid,
  opening_debit numeric,
  opening_credit numeric,
  period_debit numeric,
  period_credit numeric
)
language sql
stable
security invoker
as $$
  with scoped as (
    select
      jl.account_id,
      je.entry_date,
      jl.debit,
      jl.credit
    from public.teller_journal_lines jl
    join public.teller_journal_entries je on je.id = jl.entry_id
    where je.organization_id = p_organization_id
      and je.entry_date <= p_period_end
  )
  select
    account_id,
    coalesce(sum(case when entry_date < p_period_start then debit else 0 end), 0) as opening_debit,
    coalesce(sum(case when entry_date < p_period_start then credit else 0 end), 0) as opening_credit,
    coalesce(sum(case when entry_date >= p_period_start and entry_date <= p_period_end then debit else 0 end), 0) as period_debit,
    coalesce(sum(case when entry_date >= p_period_start and entry_date <= p_period_end then credit else 0 end), 0) as period_credit
  from scoped
  group by account_id;
$$;

grant execute on function public.teller_gl_account_totals(uuid, date, date) to authenticated;
grant execute on function public.teller_gl_account_totals(uuid, date, date) to service_role;
