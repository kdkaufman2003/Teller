-- Phase 8: Fixed assets & depreciation subledger

-- ---------------------------------------------------------------------------
-- Journal line dimension: fixed_asset_id
-- ---------------------------------------------------------------------------

alter table public.teller_journal_lines
  add column if not exists fixed_asset_id uuid;

-- FK added after teller_fixed_assets table exists

-- ---------------------------------------------------------------------------
-- Fixed asset settings (org-level policy)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_fixed_asset_settings (
  organization_id uuid primary key references public.teller_organizations (id) on delete cascade,
  capitalization_threshold numeric(14, 2),
  depreciation_convention text not null default 'full_month'
    check (depreciation_convention in ('full_month', 'next_full_month')),
  depreciation_posting_mode text not null default 'manual'
    check (depreciation_posting_mode in ('manual')),
  depreciation_posting_day smallint not null default 1
    check (depreciation_posting_day between 1 and 28),
  rounding_policy text not null default 'last_period'
    check (rounding_policy in ('last_period', 'per_period')),
  updated_at timestamptz not null default now()
);

alter table public.teller_fixed_asset_settings enable row level security;

create policy "teller members read fixed asset settings"
  on public.teller_fixed_asset_settings for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage fixed asset settings"
  on public.teller_fixed_asset_settings for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Fixed asset categories
-- ---------------------------------------------------------------------------

create table if not exists public.teller_fixed_asset_categories (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  code text not null,
  name text not null,
  description text not null default '',
  default_useful_life_months integer not null default 60,
  default_depreciation_method text not null default 'straight_line'
    check (default_depreciation_method in ('straight_line')),
  default_salvage_value numeric(14, 2) not null default 0,
  asset_account_id uuid references public.teller_accounts (id) on delete set null,
  accumulated_depreciation_account_id uuid references public.teller_accounts (id) on delete set null,
  depreciation_expense_account_id uuid references public.teller_accounts (id) on delete set null,
  gain_account_id uuid references public.teller_accounts (id) on delete set null,
  loss_account_id uuid references public.teller_accounts (id) on delete set null,
  active boolean not null default true,
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, code)
);

create index if not exists teller_fixed_asset_categories_org_idx
  on public.teller_fixed_asset_categories (organization_id, active, sort_order);

alter table public.teller_fixed_asset_categories enable row level security;

create policy "teller members read fixed asset categories"
  on public.teller_fixed_asset_categories for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage fixed asset categories"
  on public.teller_fixed_asset_categories for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Fixed assets register
-- ---------------------------------------------------------------------------

create table if not exists public.teller_fixed_assets (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  asset_number text not null,
  name text not null,
  description text not null default '',
  category_id uuid references public.teller_fixed_asset_categories (id) on delete set null,
  status text not null default 'draft'
    check (status in ('draft', 'active', 'disposed')),
  acquisition_mode text not null default 'linked'
    check (acquisition_mode in ('linked', 'new_acquisition', 'opening_balance')),
  acquisition_date date,
  placed_in_service_date date,
  vendor_party_id uuid references public.teller_parties (id) on delete set null,
  purchase_document_id uuid references public.teller_documents (id) on delete set null,
  purchase_document_line_id uuid references public.teller_document_lines (id) on delete set null,
  acquisition_journal_entry_id uuid references public.teller_journal_entries (id) on delete set null,
  capitalization_journal_entry_id uuid references public.teller_journal_entries (id) on delete set null,
  opening_accum_depr_journal_entry_id uuid references public.teller_journal_entries (id) on delete set null,
  original_cost numeric(14, 2) not null default 0,
  salvage_value numeric(14, 2) not null default 0,
  useful_life_months integer not null default 0,
  depreciation_method text not null default 'straight_line'
    check (depreciation_method in ('straight_line')),
  depreciation_start_date date,
  asset_account_id uuid references public.teller_accounts (id) on delete set null,
  accumulated_depreciation_account_id uuid references public.teller_accounts (id) on delete set null,
  depreciation_expense_account_id uuid references public.teller_accounts (id) on delete set null,
  gain_account_id uuid references public.teller_accounts (id) on delete set null,
  loss_account_id uuid references public.teller_accounts (id) on delete set null,
  serial_number text not null default '',
  vin text not null default '',
  location_id uuid references public.teller_locations (id) on delete set null,
  location_text text not null default '',
  assigned_user_id uuid references auth.users (id) on delete set null,
  job_id uuid references public.teller_jobs (id) on delete set null,
  notes text not null default '',
  attachment_path text,
  metadata jsonb not null default '{}'::jsonb,
  disposal_date date,
  disposal_type text
    check (
      disposal_type is null
      or disposal_type in ('sold', 'retired', 'written_off', 'lost', 'other')
    ),
  disposal_proceeds numeric(14, 2) not null default 0,
  disposal_reason text not null default '',
  disposal_journal_entry_id uuid references public.teller_journal_entries (id) on delete set null,
  activated_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, asset_number),
  check (original_cost >= 0),
  check (salvage_value >= 0),
  check (salvage_value <= original_cost)
);

create unique index if not exists teller_fixed_assets_purchase_line_uidx
  on public.teller_fixed_assets (organization_id, purchase_document_line_id)
  where purchase_document_line_id is not null;

create unique index if not exists teller_fixed_assets_acquisition_journal_uidx
  on public.teller_fixed_assets (organization_id, acquisition_journal_entry_id)
  where acquisition_journal_entry_id is not null;

create index if not exists teller_fixed_assets_org_status_idx
  on public.teller_fixed_assets (organization_id, status, placed_in_service_date);

alter table public.teller_fixed_assets enable row level security;

create policy "teller members read fixed assets"
  on public.teller_fixed_assets for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage fixed assets"
  on public.teller_fixed_assets for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

alter table public.teller_journal_lines
  add constraint teller_journal_lines_fixed_asset_id_fkey
  foreign key (fixed_asset_id) references public.teller_fixed_assets (id) on delete set null;

create index if not exists teller_journal_lines_org_fixed_asset_idx
  on public.teller_journal_lines (fixed_asset_id)
  where fixed_asset_id is not null;

-- ---------------------------------------------------------------------------
-- Depreciation schedule (calculated, non-posting)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_fixed_asset_depreciation_schedule_lines (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  asset_id uuid not null references public.teller_fixed_assets (id) on delete cascade,
  period_year smallint not null,
  period_month smallint not null check (period_month between 1 and 12),
  period_start_date date not null,
  beginning_book_value numeric(14, 2) not null default 0,
  depreciation_amount numeric(14, 2) not null default 0,
  accumulated_depreciation numeric(14, 2) not null default 0,
  ending_book_value numeric(14, 2) not null default 0,
  is_final_period boolean not null default false,
  calculated_at timestamptz not null default now(),
  unique (asset_id, period_year, period_month)
);

create index if not exists teller_fa_depr_schedule_org_period_idx
  on public.teller_fixed_asset_depreciation_schedule_lines (organization_id, period_year, period_month);

alter table public.teller_fixed_asset_depreciation_schedule_lines enable row level security;

create policy "teller members read fa depreciation schedule"
  on public.teller_fixed_asset_depreciation_schedule_lines for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage fa depreciation schedule"
  on public.teller_fixed_asset_depreciation_schedule_lines for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Depreciation batches (one journal per org/period)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_fixed_asset_depreciation_batches (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  period_year smallint not null,
  period_month smallint not null check (period_month between 1 and 12),
  journal_entry_id uuid references public.teller_journal_entries (id) on delete set null,
  reversal_journal_entry_id uuid references public.teller_journal_entries (id) on delete set null,
  total_amount numeric(14, 2) not null default 0,
  asset_count integer not null default 0,
  status text not null default 'posted'
    check (status in ('posted', 'reversed')),
  memo text not null default '',
  posted_at timestamptz,
  posted_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists teller_fa_depr_batches_active_period_uidx
  on public.teller_fixed_asset_depreciation_batches (organization_id, period_year, period_month)
  where status = 'posted';

alter table public.teller_fixed_asset_depreciation_batches enable row level security;

create policy "teller members read fa depreciation batches"
  on public.teller_fixed_asset_depreciation_batches for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage fa depreciation batches"
  on public.teller_fixed_asset_depreciation_batches for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Posted depreciation entries (subledger)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_fixed_asset_depreciation_entries (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  asset_id uuid not null references public.teller_fixed_assets (id) on delete cascade,
  batch_id uuid references public.teller_fixed_asset_depreciation_batches (id) on delete set null,
  period_year smallint not null,
  period_month smallint not null check (period_month between 1 and 12),
  amount numeric(14, 2) not null,
  status text not null default 'posted'
    check (status in ('posted', 'reversed')),
  journal_entry_id uuid not null references public.teller_journal_entries (id) on delete restrict,
  reversal_journal_entry_id uuid references public.teller_journal_entries (id) on delete set null,
  replaces_entry_id uuid references public.teller_fixed_asset_depreciation_entries (id) on delete set null,
  posted_at timestamptz not null default now(),
  posted_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists teller_fa_depr_entries_active_period_uidx
  on public.teller_fixed_asset_depreciation_entries (asset_id, period_year, period_month)
  where status = 'posted';

create index if not exists teller_fa_depr_entries_org_period_idx
  on public.teller_fixed_asset_depreciation_entries (organization_id, period_year, period_month);

alter table public.teller_fixed_asset_depreciation_entries enable row level security;

create policy "teller members read fa depreciation entries"
  on public.teller_fixed_asset_depreciation_entries for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage fa depreciation entries"
  on public.teller_fixed_asset_depreciation_entries for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Asset ↔ journal links
-- ---------------------------------------------------------------------------

create table if not exists public.teller_fixed_asset_journal_links (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  fixed_asset_id uuid not null references public.teller_fixed_assets (id) on delete cascade,
  journal_entry_id uuid not null references public.teller_journal_entries (id) on delete cascade,
  link_kind text not null
    check (link_kind in (
      'acquisition',
      'capitalization',
      'opening_balance',
      'opening_accum_depr',
      'depreciation',
      'disposal',
      'disposal_reversal',
      'reversal'
    )),
  depreciation_entry_id uuid references public.teller_fixed_asset_depreciation_entries (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (fixed_asset_id, journal_entry_id, link_kind)
);

create index if not exists teller_fa_journal_links_entry_idx
  on public.teller_fixed_asset_journal_links (journal_entry_id);

alter table public.teller_fixed_asset_journal_links enable row level security;

create policy "teller members read fa journal links"
  on public.teller_fixed_asset_journal_links for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage fa journal links"
  on public.teller_fixed_asset_journal_links for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- teller_post_journal — backward-compatible fixed_asset_id on lines
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
      fixed_asset_id,
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
      nullif(v_line->>'fixed_asset_id', '')::uuid,
      coalesce(v_line->>'memo', '')
    );
  end loop;

  return v_entry_id;
end;
$$;

grant execute on function public.teller_post_journal(uuid, date, text, text, uuid, uuid, jsonb)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Banking: add fixed_asset_acquisition category (preserves Phase 5 behavior)
-- ---------------------------------------------------------------------------

create or replace function public.teller_categorize_bank_transaction(
  p_organization_id uuid,
  p_bank_transaction_id uuid,
  p_category_kind text,
  p_account_id uuid,
  p_party_id uuid,
  p_job_id uuid,
  p_memo text,
  p_idempotency_event_id text,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_txn public.teller_bank_transactions%rowtype;
  v_bank_account public.teller_bank_accounts%rowtype;
  v_gl_kind text;
  v_amount numeric(14, 2);
  v_closed_through date;
  v_existing public.teller_bank_matches%rowtype;
  v_document_id uuid;
  v_document_number text;
  v_entry_id uuid;
  v_match public.teller_bank_matches%rowtype;
  v_lines jsonb;
  v_resource_type text;
  v_resource_id uuid;
  v_source_kind text;
  v_description text;
begin
  if coalesce(trim(p_idempotency_event_id), '') = '' then
    raise exception 'Idempotency event id is required';
  end if;

  if p_category_kind not in (
    'expense',
    'bank_fee',
    'interest_income',
    'interest_expense',
    'owner_contribution',
    'owner_draw',
    'fixed_asset_acquisition'
  ) then
    raise exception 'Unsupported category kind: %', p_category_kind;
  end if;

  if auth.uid() is not null
     and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to categorize bank transaction';
  end if;

  select * into v_existing
  from public.teller_bank_matches
  where organization_id = p_organization_id
    and idempotency_event_id = p_idempotency_event_id
    and status = 'confirmed';

  if found then
    return jsonb_build_object(
      'bank_transaction_id', v_existing.bank_transaction_id,
      'match_id', v_existing.id,
      'matched_resource_type', v_existing.matched_resource_type,
      'matched_resource_id', v_existing.matched_resource_id,
      'duplicate', true
    );
  end if;

  select * into v_txn
  from public.teller_bank_transactions
  where id = p_bank_transaction_id
    and organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'Bank transaction not found in organization';
  end if;

  if v_txn.provider_lifecycle_state in ('provider_removed', 'superseded') then
    raise exception 'Cannot categorize inactive bank transaction';
  end if;

  if v_txn.status in ('excluded', 'reconciled', 'categorized') then
    raise exception 'Bank transaction status % cannot be categorized', v_txn.status;
  end if;

  if coalesce(v_txn.normalized_amount, 0) = 0 then
    raise exception 'Cannot categorize zero-amount bank transaction';
  end if;

  select * into v_bank_account
  from public.teller_bank_accounts
  where id = v_txn.bank_account_id
    and organization_id = p_organization_id;

  if v_bank_account.gl_account_id is null then
    raise exception 'Bank account is missing a linked GL account';
  end if;

  perform public.teller_assert_org_postable_account(p_organization_id, p_account_id);
  perform public.teller_assert_org_party(p_organization_id, p_party_id);

  if p_job_id is not null and not exists (
    select 1 from public.teller_jobs j
    where j.id = p_job_id and j.organization_id = p_organization_id
  ) then
    raise exception 'Job % does not belong to organization', p_job_id;
  end if;

  v_closed_through := public.teller_books_closed_through(p_organization_id);
  if v_closed_through is not null and v_txn.posted_date <= v_closed_through then
    raise exception 'Accounting period is closed through %', v_closed_through;
  end if;

  v_gl_kind := public.teller_bank_account_gl_kind(v_txn.bank_account_id);
  v_amount := round(abs(v_txn.normalized_amount)::numeric, 2);
  v_description := coalesce(nullif(trim(p_memo), ''), v_txn.description, v_txn.name, 'Bank transaction');

  if v_gl_kind = 'credit_card_liability' and v_txn.normalized_amount < 0 then
    raise exception 'Credit card payments must be matched, not categorized';
  end if;

  if p_category_kind = 'fixed_asset_acquisition' then
    if v_gl_kind <> 'asset_bank' or v_txn.normalized_amount >= 0 then
      raise exception 'Fixed asset acquisition requires an outflow bank transaction';
    end if;

    v_resource_type := 'journal_entry';
    v_source_kind := 'fixed-asset-acquisition';

    v_lines := jsonb_build_array(
      jsonb_build_object(
        'account_id', p_account_id,
        'debit', v_amount,
        'credit', 0,
        'party_id', p_party_id,
        'memo', v_description
      ),
      jsonb_build_object(
        'account_id', v_bank_account.gl_account_id,
        'debit', 0,
        'credit', v_amount,
        'party_id', p_party_id,
        'memo', 'Fixed asset acquisition'
      )
    );

    v_entry_id := public.teller_post_journal(
      p_organization_id,
      v_txn.posted_date,
      v_description,
      v_source_kind,
      null,
      null,
      v_lines
    );

    v_resource_id := v_entry_id;

  elsif p_category_kind = 'expense' then
    v_document_number := public.teller_next_expense_number(p_organization_id);

    insert into public.teller_documents (
      organization_id,
      kind,
      number,
      party_id,
      job_id,
      status,
      issue_date,
      due_date,
      subtotal,
      tax,
      total,
      amount_paid,
      memo
    )
    values (
      p_organization_id,
      'expense',
      v_document_number,
      p_party_id,
      p_job_id,
      'paid',
      v_txn.posted_date,
      null,
      v_amount,
      0,
      v_amount,
      v_amount,
      v_description
    )
    returning id into v_document_id;

    insert into public.teller_document_lines (
      document_id,
      description,
      quantity,
      unit_price,
      amount,
      account_id,
      item_type,
      sort_order
    )
    values (
      v_document_id,
      v_description,
      1,
      v_amount,
      v_amount,
      p_account_id,
      'expense',
      0
    );

    v_resource_type := 'document';
    v_resource_id := v_document_id;
    v_source_kind := 'expense';

    if v_gl_kind = 'asset_bank' then
      if v_txn.normalized_amount < 0 then
        v_lines := jsonb_build_array(
          jsonb_build_object(
            'account_id', p_account_id,
            'debit', v_amount,
            'credit', 0,
            'party_id', p_party_id,
            'job_id', p_job_id,
            'memo', v_description
          ),
          jsonb_build_object(
            'account_id', v_bank_account.gl_account_id,
            'debit', 0,
            'credit', v_amount,
            'party_id', p_party_id,
            'job_id', p_job_id,
            'memo', 'Bank expense'
          )
        );
      else
        raise exception 'Expense category requires an outflow bank transaction';
      end if;
    else
      v_lines := jsonb_build_array(
        jsonb_build_object(
          'account_id', p_account_id,
          'debit', v_amount,
          'credit', 0,
          'party_id', p_party_id,
          'job_id', p_job_id,
          'memo', v_description
        ),
        jsonb_build_object(
          'account_id', v_bank_account.gl_account_id,
          'debit', 0,
          'credit', v_amount,
          'party_id', p_party_id,
          'job_id', p_job_id,
          'memo', 'Credit card expense'
        )
      );
    end if;

    v_entry_id := public.teller_post_journal(
      p_organization_id,
      v_txn.posted_date,
      'Expense ' || v_document_number,
      v_source_kind,
      v_document_id,
      null,
      v_lines
    );

    update public.teller_documents
    set posted_entry_id = v_entry_id
    where id = v_document_id;

    insert into public.teller_document_journal_links (
      organization_id,
      document_id,
      journal_entry_id,
      link_kind
    )
    values (
      p_organization_id,
      v_document_id,
      v_entry_id,
      'accrual'
    )
    on conflict (document_id, journal_entry_id) do nothing;
  else
    v_resource_type := p_category_kind;
    v_source_kind := 'bank-' || replace(p_category_kind, '_', '-');

    if v_gl_kind = 'asset_bank' then
      if v_txn.normalized_amount < 0 then
        v_lines := jsonb_build_array(
          jsonb_build_object(
            'account_id', p_account_id,
            'debit', v_amount,
            'credit', 0,
            'party_id', p_party_id,
            'job_id', p_job_id,
            'memo', v_description
          ),
          jsonb_build_object(
            'account_id', v_bank_account.gl_account_id,
            'debit', 0,
            'credit', v_amount,
            'party_id', p_party_id,
            'job_id', p_job_id,
            'memo', v_description
          )
        );
      else
        v_lines := jsonb_build_array(
          jsonb_build_object(
            'account_id', v_bank_account.gl_account_id,
            'debit', v_amount,
            'credit', 0,
            'party_id', p_party_id,
            'job_id', p_job_id,
            'memo', v_description
          ),
          jsonb_build_object(
            'account_id', p_account_id,
            'debit', 0,
            'credit', v_amount,
            'party_id', p_party_id,
            'job_id', p_job_id,
            'memo', v_description
          )
        );
      end if;
    else
      v_lines := jsonb_build_array(
        jsonb_build_object(
          'account_id', p_account_id,
          'debit', v_amount,
          'credit', 0,
          'party_id', p_party_id,
          'job_id', p_job_id,
          'memo', v_description
        ),
        jsonb_build_object(
          'account_id', v_bank_account.gl_account_id,
          'debit', 0,
          'credit', v_amount,
          'party_id', p_party_id,
          'job_id', p_job_id,
          'memo', v_description
        )
      );
    end if;

    v_entry_id := public.teller_post_journal(
      p_organization_id,
      v_txn.posted_date,
      v_description,
      v_source_kind,
      null,
      null,
      v_lines
    );

    v_resource_id := v_entry_id;
  end if;

  insert into public.teller_bank_matches (
    organization_id, bank_transaction_id, matched_resource_type, matched_resource_id,
    matched_amount, status, match_method, idempotency_event_id, created_by, confirmed_at
  ) values (
    p_organization_id, v_txn.id, v_resource_type, v_resource_id, v_amount,
    'confirmed', 'categorize', p_idempotency_event_id, coalesce(p_actor_id, auth.uid()), now()
  )
  returning * into v_match;

  update public.teller_bank_transactions
  set status = 'categorized', updated_at = now()
  where id = v_txn.id;

  insert into public.teller_audit_events (
    organization_id, actor_id, action, resource_kind, resource_id, metadata
  ) values (
    p_organization_id, coalesce(p_actor_id, auth.uid()), 'bank_transaction.categorized',
    'bank_transaction', v_txn.id,
    jsonb_build_object(
      'category_kind', p_category_kind,
      'account_id', p_account_id,
      'journal_entry_id', v_entry_id,
      'match_id', v_match.id,
      'matched_resource_type', v_resource_type,
      'matched_resource_id', v_resource_id,
      'amount', v_amount,
      'idempotency_event_id', p_idempotency_event_id
    )
  );

  return jsonb_build_object(
    'bank_transaction_id', v_txn.id,
    'status', 'categorized',
    'journal_entry_id', v_entry_id,
    'match_id', v_match.id,
    'matched_resource_type', v_resource_type,
    'matched_resource_id', v_resource_id,
    'document_id', v_document_id,
    'duplicate', false
  );
end;
$$;

grant execute on function public.teller_categorize_bank_transaction(
  uuid, uuid, text, uuid, uuid, uuid, text, text, uuid
) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Disposal idempotency (atomic RPC retries — operation UUID per attempt)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_fixed_asset_disposal_idempotency (
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  idempotency_key uuid not null,
  asset_id uuid not null references public.teller_fixed_assets (id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'completed')),
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (organization_id, idempotency_key)
);

create index if not exists teller_fa_disposal_idempotency_asset_idx
  on public.teller_fixed_asset_disposal_idempotency (asset_id);

alter table public.teller_fixed_asset_disposal_idempotency enable row level security;

create policy "teller members read fa disposal idempotency"
  on public.teller_fixed_asset_disposal_idempotency for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage fa disposal idempotency"
  on public.teller_fixed_asset_disposal_idempotency for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Atomic fixed asset disposal — internal core (not granted to callers)
-- Catch-up depreciation uses the same subledger rows as manual posting:
-- teller_fixed_asset_depreciation_entries (batch_id nullable), journal links,
-- fixed_asset_id on lines, period uniqueness via partial unique index.
-- ---------------------------------------------------------------------------

create or replace function public.teller_dispose_fixed_asset_core(
  p_organization_id uuid,
  p_asset_id uuid,
  p_disposal_date date,
  p_disposal_type text,
  p_proceeds numeric,
  p_cash_account_id uuid,
  p_reason text,
  p_idempotency_key uuid,
  p_actor_id uuid,
  p_simulate_failure_after text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_asset public.teller_fixed_assets%rowtype;
  v_category public.teller_fixed_asset_categories%rowtype;
  v_existing_result jsonb;
  v_claim_status text;
  v_claim_asset_id uuid;
  v_asset_account_id uuid;
  v_accum_account_id uuid;
  v_expense_account_id uuid;
  v_gain_account_id uuid;
  v_loss_account_id uuid;
  v_cash_account_id uuid;
  v_closed_through date;
  v_disposal_year smallint;
  v_disposal_month smallint;
  v_posted_accum numeric(14, 2) := 0;
  v_basis numeric(14, 2);
  v_nbv numeric(14, 2);
  v_proceeds numeric(14, 2);
  v_gain_loss numeric(14, 2);
  v_cost numeric(14, 2);
  v_schedule public.teller_fixed_asset_depreciation_schedule_lines%rowtype;
  v_depr_journal_id uuid;
  v_depr_entry_id uuid;
  v_disposal_journal_id uuid;
  v_depr_journal_ids uuid[] := '{}';
  v_depr_entry_ids uuid[] := '{}';
  v_lines jsonb;
  v_total_debit numeric(14, 2);
  v_total_credit numeric(14, 2);
  v_audit_action text;
  v_updated integer;
begin
  if p_idempotency_key is null then
    raise exception 'Idempotency key is required';
  end if;

  if p_disposal_type not in ('sold', 'retired', 'written_off', 'lost', 'other') then
    raise exception 'Invalid disposal type: %', p_disposal_type;
  end if;

  if not exists (
    select 1 from public.teller_organizations where id = p_organization_id
  ) then
    raise exception 'Organization not found';
  end if;

  if auth.uid() is not null then
    if not public.teller_is_org_member(p_organization_id) then
      raise exception 'Not a member of this organization';
    end if;
    if not public.teller_can_write_books(p_organization_id) then
      raise exception 'Not authorized to dispose fixed assets';
    end if;
    if p_actor_id is not null and p_actor_id <> auth.uid() then
      raise exception 'Actor must match authenticated user';
    end if;
  elsif p_actor_id is not null then
    if not exists (
      select 1
      from public.teller_profiles
      where id = p_actor_id
        and organization_id = p_organization_id
    ) then
      raise exception 'Actor is not a member of this organization';
    end if;
  end if;

  <<claim_idempotency>>
  loop
    begin
      insert into public.teller_fixed_asset_disposal_idempotency (
        organization_id,
        idempotency_key,
        asset_id,
        status,
        result
      ) values (
        p_organization_id,
        p_idempotency_key,
        p_asset_id,
        'pending',
        '{}'::jsonb
      );
      exit claim_idempotency;
    exception
      when unique_violation then
        select status, result, asset_id
        into v_claim_status, v_existing_result, v_claim_asset_id
        from public.teller_fixed_asset_disposal_idempotency
        where organization_id = p_organization_id
          and idempotency_key = p_idempotency_key
        for update;

        if not found then
          continue claim_idempotency;
        end if;

        if v_claim_asset_id <> p_asset_id then
          raise exception 'Idempotency conflict: operation key is tied to a different asset';
        end if;

        if v_claim_status = 'completed' then
          return v_existing_result || jsonb_build_object('duplicate', true);
        end if;

        select status, result, asset_id
        into v_claim_status, v_existing_result, v_claim_asset_id
        from public.teller_fixed_asset_disposal_idempotency
        where organization_id = p_organization_id
          and idempotency_key = p_idempotency_key;

        if not found then
          continue claim_idempotency;
        end if;

        if v_claim_asset_id <> p_asset_id then
          raise exception 'Idempotency conflict: operation key is tied to a different asset';
        end if;

        if v_claim_status = 'completed' then
          return v_existing_result || jsonb_build_object('duplicate', true);
        end if;

        raise exception 'Disposal operation already in progress for this idempotency key';
    end;
  end loop;

  select * into v_asset
  from public.teller_fixed_assets
  where id = p_asset_id
    and organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'Fixed asset not found in organization';
  end if;

  if v_asset.status <> 'active' then
    raise exception 'Only active assets can be disposed';
  end if;

  if v_asset.disposal_journal_entry_id is not null then
    raise exception 'Asset is already disposed';
  end if;

  v_closed_through := public.teller_books_closed_through(p_organization_id);
  if v_closed_through is not null and p_disposal_date <= v_closed_through then
    raise exception 'Accounting period is closed through %', v_closed_through;
  end if;

  v_disposal_year := extract(year from p_disposal_date)::smallint;
  v_disposal_month := extract(month from p_disposal_date)::smallint;
  v_proceeds := round(coalesce(p_proceeds, 0)::numeric, 2);
  v_cost := round(coalesce(v_asset.original_cost, 0)::numeric, 2);
  v_basis := greatest(0, round(v_cost - coalesce(v_asset.salvage_value, 0)::numeric, 2));

  if v_asset.category_id is not null then
    select * into v_category
    from public.teller_fixed_asset_categories
    where id = v_asset.category_id
      and organization_id = p_organization_id;
  end if;

  v_asset_account_id := coalesce(v_asset.asset_account_id, v_category.asset_account_id);
  v_accum_account_id := coalesce(v_asset.accumulated_depreciation_account_id, v_category.accumulated_depreciation_account_id);
  v_expense_account_id := coalesce(v_asset.depreciation_expense_account_id, v_category.depreciation_expense_account_id);
  v_gain_account_id := coalesce(v_asset.gain_account_id, v_category.gain_account_id);
  v_loss_account_id := coalesce(v_asset.loss_account_id, v_category.loss_account_id);

  if v_asset_account_id is null or v_accum_account_id is null
     or v_expense_account_id is null or v_gain_account_id is null or v_loss_account_id is null then
    raise exception 'Fixed asset account mappings are incomplete';
  end if;

  if not exists (
    select 1 from public.teller_accounts
    where id = v_asset_account_id and organization_id = p_organization_id
  ) then
    raise exception 'Asset account does not belong to organization';
  end if;

  v_cash_account_id := p_cash_account_id;
  if v_proceeds > 0 then
    if v_cash_account_id is null then
      select id into v_cash_account_id
      from public.teller_accounts
      where organization_id = p_organization_id
        and subtype = 'bank'
      order by code
      limit 1;
    end if;
    if v_cash_account_id is null then
      raise exception 'Cash account is required for disposal proceeds';
    end if;
    if not exists (
      select 1 from public.teller_accounts
      where id = v_cash_account_id and organization_id = p_organization_id
    ) then
      raise exception 'Cash account does not belong to organization';
    end if;
  end if;

  for v_schedule in
    select *
    from public.teller_fixed_asset_depreciation_schedule_lines
    where asset_id = p_asset_id
      and organization_id = p_organization_id
      and (
        period_year < v_disposal_year
        or (period_year = v_disposal_year and period_month <= v_disposal_month)
      )
    order by period_year, period_month
  loop
    if coalesce(v_schedule.depreciation_amount, 0) <= 0 then
      continue;
    end if;

    if exists (
      select 1
      from public.teller_fixed_asset_depreciation_entries
      where asset_id = p_asset_id
        and period_year = v_schedule.period_year
        and period_month = v_schedule.period_month
        and status = 'posted'
    ) then
      continue;
    end if;

    select coalesce(sum(amount), 0) into v_posted_accum
    from public.teller_fixed_asset_depreciation_entries
    where asset_id = p_asset_id
      and status = 'posted';

    if v_basis > 0 and v_posted_accum >= v_basis - 0.009 then
      exit;
    end if;

    if v_closed_through is not null
       and v_schedule.period_start_date <= v_closed_through then
      raise exception 'Accounting period is closed through %', v_closed_through;
    end if;

    v_lines := jsonb_build_array(
      jsonb_build_object(
        'account_id', v_expense_account_id,
        'debit', round(v_schedule.depreciation_amount::numeric, 2),
        'credit', 0,
        'fixed_asset_id', p_asset_id,
        'memo', format('Depreciation %s %s-%s', v_asset.asset_number, v_schedule.period_year, lpad(v_schedule.period_month::text, 2, '0'))
      ),
      jsonb_build_object(
        'account_id', v_accum_account_id,
        'debit', 0,
        'credit', round(v_schedule.depreciation_amount::numeric, 2),
        'fixed_asset_id', p_asset_id,
        'memo', format('Depreciation %s %s-%s', v_asset.asset_number, v_schedule.period_year, lpad(v_schedule.period_month::text, 2, '0'))
      )
    );

    v_depr_journal_id := public.teller_post_journal(
      p_organization_id,
      v_schedule.period_start_date,
      format(
        'Depreciation %s %s-%s',
        v_asset.asset_number,
        v_schedule.period_year,
        lpad(v_schedule.period_month::text, 2, '0')
      ),
      'fixed-asset-depreciation',
      p_asset_id,
      null,
      v_lines
    );

    insert into public.teller_fixed_asset_depreciation_entries (
      organization_id,
      asset_id,
      batch_id,
      period_year,
      period_month,
      amount,
      status,
      journal_entry_id,
      posted_by
    )
    values (
      p_organization_id,
      p_asset_id,
      null,
      v_schedule.period_year,
      v_schedule.period_month,
      round(v_schedule.depreciation_amount::numeric, 2),
      'posted',
      v_depr_journal_id,
      p_actor_id
    )
    returning id into v_depr_entry_id;

    insert into public.teller_fixed_asset_journal_links (
      organization_id,
      fixed_asset_id,
      journal_entry_id,
      link_kind,
      depreciation_entry_id
    )
    values (
      p_organization_id,
      p_asset_id,
      v_depr_journal_id,
      'depreciation',
      v_depr_entry_id
    )
    on conflict (fixed_asset_id, journal_entry_id, link_kind) do nothing;

    v_depr_journal_ids := array_append(v_depr_journal_ids, v_depr_journal_id);
    v_depr_entry_ids := array_append(v_depr_entry_ids, v_depr_entry_id);
  end loop;

  if p_simulate_failure_after = 'after_depreciation' then
    raise exception 'Simulated disposal failure after depreciation (controlled test)';
  end if;

  select coalesce(sum(amount), 0) into v_posted_accum
  from public.teller_fixed_asset_depreciation_entries
  where asset_id = p_asset_id
    and status = 'posted';

  v_nbv := round(v_cost - v_posted_accum, 2);
  v_gain_loss := round(v_proceeds - v_nbv, 2);

  v_lines := jsonb_build_array();

  if v_proceeds > 0 then
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object(
        'account_id', v_cash_account_id,
        'debit', v_proceeds,
        'credit', 0,
        'memo', format('Proceeds %s', v_asset.asset_number)
      )
    );
  end if;

  if v_posted_accum > 0 then
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object(
        'account_id', v_accum_account_id,
        'debit', v_posted_accum,
        'credit', 0,
        'fixed_asset_id', p_asset_id,
        'memo', format('Remove accum depr %s', v_asset.asset_number)
      )
    );
  end if;

  v_lines := v_lines || jsonb_build_array(
    jsonb_build_object(
      'account_id', v_asset_account_id,
      'debit', 0,
      'credit', v_cost,
      'fixed_asset_id', p_asset_id,
      'memo', format('Dispose %s', v_asset.asset_number)
    )
  );

  if v_gain_loss > 0 then
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object(
        'account_id', v_gain_account_id,
        'debit', 0,
        'credit', v_gain_loss,
        'fixed_asset_id', p_asset_id,
        'memo', format('Gain on disposal %s', v_asset.asset_number)
      )
    );
  elsif v_gain_loss < 0 then
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object(
        'account_id', v_loss_account_id,
        'debit', abs(v_gain_loss),
        'credit', 0,
        'fixed_asset_id', p_asset_id,
        'memo', format('Loss on disposal %s', v_asset.asset_number)
      )
    );
  end if;

  select
    coalesce(sum(coalesce((elem->>'debit')::numeric, 0)), 0),
    coalesce(sum(coalesce((elem->>'credit')::numeric, 0)), 0)
  into v_total_debit, v_total_credit
  from jsonb_array_elements(v_lines) as elem;

  if abs(v_total_debit - v_total_credit) > 0.009 then
    raise exception 'Disposal journal is unbalanced: debit % vs credit %', v_total_debit, v_total_credit;
  end if;

  v_disposal_journal_id := public.teller_post_journal(
    p_organization_id,
    p_disposal_date,
    format('Dispose fixed asset %s', v_asset.asset_number),
    'fixed-asset-disposal',
    p_asset_id,
    null,
    v_lines
  );

  if p_simulate_failure_after = 'before_asset_update' then
    raise exception 'Simulated disposal failure before asset update (controlled test)';
  end if;

  update public.teller_fixed_assets
  set
    status = 'disposed',
    disposal_date = p_disposal_date,
    disposal_type = p_disposal_type,
    disposal_proceeds = v_proceeds,
    disposal_reason = coalesce(p_reason, ''),
    disposal_journal_entry_id = v_disposal_journal_id,
    updated_by = p_actor_id,
    updated_at = now()
  where id = p_asset_id
    and organization_id = p_organization_id;

  insert into public.teller_fixed_asset_journal_links (
    organization_id,
    fixed_asset_id,
    journal_entry_id,
    link_kind
  )
  values (
    p_organization_id,
    p_asset_id,
    v_disposal_journal_id,
    'disposal'
  )
  on conflict (fixed_asset_id, journal_entry_id, link_kind) do nothing;

  v_audit_action := case
    when p_disposal_type = 'written_off' then 'fixed_asset.written_off'
    when v_proceeds > 0 then 'fixed_asset.sold'
    else 'fixed_asset.disposed'
  end;

  insert into public.teller_audit_events (
    organization_id,
    actor_id,
    action,
    resource_kind,
    resource_id,
    metadata
  )
  values (
    p_organization_id,
    coalesce(p_actor_id, auth.uid()),
    v_audit_action,
    'fixed_asset',
    p_asset_id,
    jsonb_build_object(
      'disposalJournalEntryId', v_disposal_journal_id,
      'depreciationJournalEntryIds', to_jsonb(v_depr_journal_ids),
      'nbv', v_nbv,
      'proceeds', v_proceeds,
      'gainLoss', v_gain_loss,
      'postedAccum', v_posted_accum,
      'idempotencyKey', p_idempotency_key
    )
  );

  v_existing_result := jsonb_build_object(
    'asset_id', p_asset_id,
    'disposal_journal_entry_id', v_disposal_journal_id,
    'depreciation_journal_entry_ids', to_jsonb(v_depr_journal_ids),
    'depreciation_entry_ids', to_jsonb(v_depr_entry_ids),
    'posted_accumulated_depreciation', v_posted_accum,
    'net_book_value', v_nbv,
    'gain_loss', v_gain_loss,
    'proceeds', v_proceeds,
    'duplicate', false
  );

  update public.teller_fixed_asset_disposal_idempotency
  set
    status = 'completed',
    result = v_existing_result
  where organization_id = p_organization_id
    and idempotency_key = p_idempotency_key
    and status = 'pending';

  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'Could not finalize disposal idempotency record';
  end if;

  return v_existing_result;
end;
$$;

-- Production RPC — no test hooks
create or replace function public.teller_dispose_fixed_asset(
  p_organization_id uuid,
  p_asset_id uuid,
  p_disposal_date date,
  p_disposal_type text,
  p_proceeds numeric,
  p_cash_account_id uuid,
  p_reason text,
  p_idempotency_key uuid,
  p_actor_id uuid
)
returns jsonb
language sql
security definer
set search_path = pg_catalog, public
as $$
  select public.teller_dispose_fixed_asset_core(
    p_organization_id,
    p_asset_id,
    p_disposal_date,
    p_disposal_type,
    p_proceeds,
    p_cash_account_id,
    p_reason,
    p_idempotency_key,
    p_actor_id,
    null::text
  );
$$;

-- Controlled harness only — service_role, includes failure simulation
create or replace function public.teller_dispose_fixed_asset_controlled_test(
  p_organization_id uuid,
  p_asset_id uuid,
  p_disposal_date date,
  p_disposal_type text,
  p_proceeds numeric,
  p_cash_account_id uuid,
  p_reason text,
  p_idempotency_key uuid,
  p_actor_id uuid,
  p_simulate_failure_after text default null
)
returns jsonb
language sql
security definer
set search_path = pg_catalog, public
as $$
  select public.teller_dispose_fixed_asset_core(
    p_organization_id,
    p_asset_id,
    p_disposal_date,
    p_disposal_type,
    p_proceeds,
    p_cash_account_id,
    p_reason,
    p_idempotency_key,
    p_actor_id,
    p_simulate_failure_after
  );
$$;

grant execute on function public.teller_dispose_fixed_asset(
  uuid, uuid, date, text, numeric, uuid, text, uuid, uuid
) to authenticated, service_role;

grant execute on function public.teller_dispose_fixed_asset_controlled_test(
  uuid, uuid, date, text, numeric, uuid, text, uuid, uuid, text
) to service_role;
