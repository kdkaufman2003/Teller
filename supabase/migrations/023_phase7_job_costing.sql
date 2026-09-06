-- Phase 7: Job costing — evolve teller_jobs, cost categories, budgets, sequences, journal dimensions

-- ---------------------------------------------------------------------------
-- Document number sequences (concurrency-safe JOB-1001 style numbering)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_document_sequences (
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  sequence_key text not null,
  prefix text not null default '',
  next_value bigint not null default 1001,
  updated_at timestamptz not null default now(),
  primary key (organization_id, sequence_key)
);

comment on table public.teller_document_sequences is
  'Atomic per-org document counters (job numbers, etc.).';

create or replace function public.teller_allocate_sequence_number(
  p_organization_id uuid,
  p_sequence_key text,
  p_default_prefix text default 'JOB'
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_prefix text;
  v_num bigint;
begin
  if coalesce(trim(p_sequence_key), '') = '' then
    raise exception 'Sequence key is required';
  end if;

  if auth.uid() is not null
     and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to allocate sequence number';
  end if;

  insert into public.teller_document_sequences (
    organization_id,
    sequence_key,
    prefix,
    next_value
  )
  values (
    p_organization_id,
    p_sequence_key,
    coalesce(nullif(trim(p_default_prefix), ''), 'JOB'),
    1001
  )
  on conflict (organization_id, sequence_key) do update
    set
      next_value = public.teller_document_sequences.next_value + 1,
      updated_at = now()
  returning prefix, next_value into v_prefix, v_num;

  return v_prefix || '-' || v_num::text;
end;
$$;

grant execute on function public.teller_allocate_sequence_number(uuid, text, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Evolve teller_jobs
-- ---------------------------------------------------------------------------

alter table public.teller_jobs
  add column if not exists description text not null default '',
  add column if not exists estimated_completion_date date,
  add column if not exists closed_at timestamptz,
  add column if not exists original_contract_amount numeric(14, 2) not null default 0,
  add column if not exists revised_contract_amount numeric(14, 2),
  add column if not exists estimated_revenue numeric(14, 2) not null default 0,
  add column if not exists estimated_cost numeric(14, 2) not null default 0,
  add column if not exists project_manager_user_id uuid references auth.users (id) on delete set null,
  add column if not exists salesperson_user_id uuid references auth.users (id) on delete set null,
  add column if not exists created_by uuid references auth.users (id) on delete set null,
  add column if not exists updated_by uuid references auth.users (id) on delete set null,
  add column if not exists service_address_line1 text not null default '',
  add column if not exists service_address_line2 text not null default '',
  add column if not exists service_city text not null default '',
  add column if not exists service_state text not null default '',
  add column if not exists service_postal text not null default '',
  add column if not exists service_country text not null default 'US',
  add column if not exists close_override_reason text not null default '';

-- Backfill contract fields from legacy quoted_amount
update public.teller_jobs
set
  original_contract_amount = quoted_amount,
  estimated_revenue = case when estimated_revenue = 0 then quoted_amount else estimated_revenue end
where original_contract_amount = 0 and quoted_amount <> 0;

-- Legacy status migration (existing rows → new values)
update public.teller_jobs set status = 'draft' where status = 'estimate';
update public.teller_jobs set status = 'active' where status in ('scheduled', 'in_progress');
update public.teller_jobs set status = 'completed' where status in ('complete', 'invoiced');
-- cancelled unchanged

alter table public.teller_jobs drop constraint if exists teller_jobs_status_check;
alter table public.teller_jobs
  add constraint teller_jobs_status_check
  check (
    status in (
      -- Legacy values: allowed during migration→deploy window so old app instances keep working
      'estimate',
      'scheduled',
      'in_progress',
      'complete',
      'invoiced',
      'cancelled',
      -- Phase 7 values
      'draft',
      'active',
      'on_hold',
      'completed',
      'closed'
    )
  );

comment on constraint teller_jobs_status_check on public.teller_jobs is
  'Dual legacy+Phase7 statuses for zero-downtime deploy. Remove legacy values in a later cleanup migration after Phase 7 app is verified in production.';

alter table public.teller_jobs drop constraint if exists teller_jobs_job_type_check;
-- job_type becomes free-form text configured by industry packs

create index if not exists teller_jobs_org_customer_idx
  on public.teller_jobs (organization_id, party_id);

create index if not exists teller_jobs_org_number_idx
  on public.teller_jobs (organization_id, job_number);

create index if not exists teller_jobs_org_start_idx
  on public.teller_jobs (organization_id, started_at);

create index if not exists teller_jobs_org_completed_idx
  on public.teller_jobs (organization_id, completed_at);

-- ---------------------------------------------------------------------------
-- Job cost categories (org-configurable)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_job_cost_categories (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  code text not null,
  name text not null,
  description text not null default '',
  category_type text not null default 'other'
    check (category_type in ('material', 'labor', 'subcontract', 'equipment', 'other')),
  active boolean not null default true,
  sort_order integer not null default 0,
  default_gl_account_id uuid references public.teller_accounts (id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, code)
);

create index if not exists teller_job_cost_categories_org_active_idx
  on public.teller_job_cost_categories (organization_id, active, sort_order);

alter table public.teller_job_cost_categories enable row level security;

create policy "teller members read job cost categories"
  on public.teller_job_cost_categories for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage job cost categories"
  on public.teller_job_cost_categories for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Job budget lines (non-GL planning)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_job_budget_lines (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  job_id uuid not null references public.teller_jobs (id) on delete cascade,
  cost_category_id uuid references public.teller_job_cost_categories (id) on delete set null,
  cost_classification text not null default 'direct'
    check (cost_classification in ('direct', 'indirect', '')),
  estimated_quantity numeric(14, 4),
  estimated_unit_cost numeric(14, 4),
  estimated_amount numeric(14, 2) not null default 0,
  notes text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists teller_job_budget_lines_job_idx
  on public.teller_job_budget_lines (organization_id, job_id);

create index if not exists teller_job_budget_lines_category_idx
  on public.teller_job_budget_lines (job_id, cost_category_id);

alter table public.teller_job_budget_lines enable row level security;

create policy "teller members read job budget lines"
  on public.teller_job_budget_lines for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage job budget lines"
  on public.teller_job_budget_lines for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Analytical dimensions on document + journal lines
-- ---------------------------------------------------------------------------

alter table public.teller_document_lines
  add column if not exists cost_classification text not null default ''
    check (cost_classification in ('direct', 'indirect', ''));

alter table public.teller_journal_lines
  add column if not exists job_cost_category_id uuid
    references public.teller_job_cost_categories (id) on delete set null,
  add column if not exists cost_classification text not null default ''
    check (cost_classification in ('direct', 'indirect', ''));

create index if not exists teller_journal_lines_org_job_idx
  on public.teller_journal_lines (job_id)
  where job_id is not null;

-- ---------------------------------------------------------------------------
-- Extend teller_post_journal for optional job cost dimensions
-- ---------------------------------------------------------------------------

create or replace function public.teller_post_journal(
  p_organization_id uuid,
  p_entry_date date,
  p_memo text,
  p_source_kind text,
  p_source_id uuid,
  p_reverses_entry_id uuid,
  p_lines jsonb
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_entry_id uuid;
  v_line jsonb;
  v_debit numeric(14, 2);
  v_credit numeric(14, 2);
  v_total_debit numeric(14, 2) := 0;
  v_total_credit numeric(14, 2) := 0;
  v_closed_through date;
begin
  if auth.uid() is not null
     and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to post journal entries';
  end if;

  v_closed_through := public.teller_books_closed_through(p_organization_id);
  if v_closed_through is not null and p_entry_date <= v_closed_through then
    raise exception 'Accounting period is closed through %', v_closed_through;
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Journal entry requires at least one line';
  end if;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_debit := coalesce((v_line->>'debit')::numeric, 0);
    v_credit := coalesce((v_line->>'credit')::numeric, 0);
    v_total_debit := v_total_debit + v_debit;
    v_total_credit := v_total_credit + v_credit;
  end loop;

  if abs(v_total_debit - v_total_credit) > 0.009 then
    raise exception 'Journal entry is unbalanced: debit % vs credit %', v_total_debit, v_total_credit;
  end if;

  insert into public.teller_journal_entries (
    organization_id,
    entry_date,
    memo,
    source_kind,
    source_id,
    reverses_entry_id
  ) values (
    p_organization_id,
    p_entry_date,
    coalesce(p_memo, ''),
    p_source_kind,
    p_source_id,
    p_reverses_entry_id
  )
  returning id into v_entry_id;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    insert into public.teller_journal_lines (
      entry_id,
      account_id,
      debit,
      credit,
      party_id,
      job_id,
      job_cost_category_id,
      cost_classification,
      memo
    ) values (
      v_entry_id,
      (v_line->>'account_id')::uuid,
      coalesce((v_line->>'debit')::numeric, 0),
      coalesce((v_line->>'credit')::numeric, 0),
      nullif(v_line->>'party_id', '')::uuid,
      nullif(v_line->>'job_id', '')::uuid,
      nullif(v_line->>'job_cost_category_id', '')::uuid,
      coalesce(nullif(v_line->>'cost_classification', ''), ''),
      coalesce(v_line->>'memo', '')
    );
  end loop;

  return v_entry_id;
end;
$$;

grant execute on function public.teller_post_journal(uuid, date, text, text, uuid, uuid, jsonb)
  to authenticated, service_role;

-- Sequences RLS (writers only for allocate via RPC; direct table access read-only)
alter table public.teller_document_sequences enable row level security;

create policy "teller members read document sequences"
  on public.teller_document_sequences for select
  using (public.teller_is_org_member(organization_id));
