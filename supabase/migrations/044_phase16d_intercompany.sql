-- Phase 16D: Intercompany transactions — paired journals, due-to/due-from, atomic posting.
-- Manual apply only. Does NOT implement consolidation eliminations (16F–16G).
-- Preserves Phase 16C invariant: one journal = one legal entity.

-- ---------------------------------------------------------------------------
-- Intercompany account pairs (per entity, per counterparty — Option A COA)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_intercompany_account_pairs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  owner_legal_entity_id uuid not null references public.teller_legal_entities (id) on delete restrict,
  counterparty_legal_entity_id uuid not null references public.teller_legal_entities (id) on delete restrict,
  due_from_account_id uuid not null references public.teller_accounts (id) on delete restrict,
  due_to_account_id uuid not null references public.teller_accounts (id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint teller_ic_account_pairs_distinct check (
    owner_legal_entity_id <> counterparty_legal_entity_id
  ),
  constraint teller_ic_account_pairs_owner_counterparty_uidx unique (
    owner_legal_entity_id,
    counterparty_legal_entity_id
  )
);

create index if not exists teller_ic_account_pairs_org_idx
  on public.teller_intercompany_account_pairs (organization_id);

-- ---------------------------------------------------------------------------
-- Intercompany transaction group (links paired journals)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_intercompany_transactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  source_legal_entity_id uuid not null references public.teller_legal_entities (id) on delete restrict,
  counterparty_legal_entity_id uuid not null references public.teller_legal_entities (id) on delete restrict,
  transaction_type text not null
    check (transaction_type in (
      'expense_on_behalf',
      'cash_received_on_behalf',
      'fund_transfer',
      'manual'
    )),
  transaction_date date not null,
  description text not null default '',
  reference text,
  amount numeric(14, 2) not null check (amount > 0),
  currency text not null default 'USD',
  status text not null default 'pending'
    check (status in ('pending', 'posted', 'reversed')),
  source_journal_id uuid references public.teller_journal_entries (id) on delete restrict,
  counterparty_journal_id uuid references public.teller_journal_entries (id) on delete restrict,
  reverses_transaction_id uuid references public.teller_intercompany_transactions (id) on delete restrict,
  reversal_transaction_id uuid references public.teller_intercompany_transactions (id) on delete restrict,
  idempotency_key text,
  external_event_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  reversed_at timestamptz,
  reversed_by uuid references auth.users (id) on delete set null,
  constraint teller_ic_tx_entities_distinct check (
    source_legal_entity_id <> counterparty_legal_entity_id
  ),
  constraint teller_ic_tx_journals_required_when_posted check (
    status <> 'posted'
    or (source_journal_id is not null and counterparty_journal_id is not null)
  )
);

create unique index if not exists teller_ic_tx_idempotency_uidx
  on public.teller_intercompany_transactions (organization_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists teller_ic_tx_org_date_idx
  on public.teller_intercompany_transactions (organization_id, transaction_date desc);

create index if not exists teller_ic_tx_source_entity_idx
  on public.teller_intercompany_transactions (organization_id, source_legal_entity_id);

create index if not exists teller_ic_tx_counterparty_entity_idx
  on public.teller_intercompany_transactions (organization_id, counterparty_legal_entity_id);

-- ---------------------------------------------------------------------------
-- Immutability — posted economic fields cannot change; corrections via reversal
-- ---------------------------------------------------------------------------

create or replace function public.teller_intercompany_tx_immutable()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    if old.status = 'posted' then
      if new.source_legal_entity_id is distinct from old.source_legal_entity_id
         or new.counterparty_legal_entity_id is distinct from old.counterparty_legal_entity_id
         or new.amount is distinct from old.amount
         or new.transaction_date is distinct from old.transaction_date
         or new.transaction_type is distinct from old.transaction_type
         or new.source_journal_id is distinct from old.source_journal_id
         or new.counterparty_journal_id is distinct from old.counterparty_journal_id
         or new.idempotency_key is distinct from old.idempotency_key then
        raise exception 'Posted intercompany transaction cannot be modified';
      end if;
      if new.status = 'reversed'
         and old.status = 'posted'
         and new.reversal_transaction_id is not null then
        return new;
      end if;
      if new.status is distinct from old.status and new.status <> 'reversed' then
        raise exception 'Posted intercompany transaction cannot be modified';
      end if;
    end if;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Intercompany transactions cannot be deleted';
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists teller_intercompany_tx_immutable on public.teller_intercompany_transactions;
create trigger teller_intercompany_tx_immutable
  before update or delete on public.teller_intercompany_transactions
  for each row execute function public.teller_intercompany_tx_immutable();

-- ---------------------------------------------------------------------------
-- Provision due-to / due-from accounts per entity pair (idempotent)
-- ---------------------------------------------------------------------------

create or replace function public.teller_provision_intercompany_accounts(
  p_organization_id uuid,
  p_owner_entity_id uuid,
  p_counterparty_entity_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_pair public.teller_intercompany_account_pairs%rowtype;
  v_counterparty record;
  v_due_from_id uuid;
  v_due_to_id uuid;
  v_code_from text;
  v_code_to text;
begin
  if p_owner_entity_id = p_counterparty_entity_id then
    raise exception 'Intercompany accounts require distinct entities';
  end if;

  perform public.teller_assert_entity_belongs_to_org(p_organization_id, p_owner_entity_id);
  perform public.teller_assert_entity_belongs_to_org(p_organization_id, p_counterparty_entity_id);

  select due_from_account_id, due_to_account_id
  into v_due_from_id, v_due_to_id
  from public.teller_intercompany_account_pairs
  where owner_legal_entity_id = p_owner_entity_id
    and counterparty_legal_entity_id = p_counterparty_entity_id;

  if found then
    return jsonb_build_object(
      'due_from_account_id', v_due_from_id,
      'due_to_account_id', v_due_to_id,
      'provisioned', false
    );
  end if;

  select entity_code, name into v_counterparty
  from public.teller_legal_entities
  where id = p_counterparty_entity_id
    and organization_id = p_organization_id;

  if not found then
    raise exception 'Counterparty legal entity not found';
  end if;

  v_code_from := 'IC-DF-' || upper(v_counterparty.entity_code);
  v_code_to := 'IC-DT-' || upper(v_counterparty.entity_code);

  select id into v_due_from_id
  from public.teller_accounts
  where legal_entity_id = p_owner_entity_id
    and code = v_code_from;

  if v_due_from_id is null then
    insert into public.teller_accounts (
      organization_id,
      legal_entity_id,
      code,
      name,
      type,
      subtype,
      is_system
    ) values (
      p_organization_id,
      p_owner_entity_id,
      v_code_from,
      'Due From ' || v_counterparty.name,
      'asset',
      'due_from',
      true
    )
    returning id into v_due_from_id;
  end if;

  select id into v_due_to_id
  from public.teller_accounts
  where legal_entity_id = p_owner_entity_id
    and code = v_code_to;

  if v_due_to_id is null then
    insert into public.teller_accounts (
      organization_id,
      legal_entity_id,
      code,
      name,
      type,
      subtype,
      is_system
    ) values (
      p_organization_id,
      p_owner_entity_id,
      v_code_to,
      'Due To ' || v_counterparty.name,
      'liability',
      'due_to',
      true
    )
    returning id into v_due_to_id;
  end if;

  insert into public.teller_intercompany_account_pairs (
    organization_id,
    owner_legal_entity_id,
    counterparty_legal_entity_id,
    due_from_account_id,
    due_to_account_id
  ) values (
    p_organization_id,
    p_owner_entity_id,
    p_counterparty_entity_id,
    v_due_from_id,
    v_due_to_id
  )
  on conflict (owner_legal_entity_id, counterparty_legal_entity_id) do update
    set due_from_account_id = excluded.due_from_account_id,
        due_to_account_id = excluded.due_to_account_id
  returning due_from_account_id, due_to_account_id
  into v_due_from_id, v_due_to_id;

  return jsonb_build_object(
    'due_from_account_id', v_due_from_id,
    'due_to_account_id', v_due_to_id,
    'provisioned', true
  );
end;
$$;

grant execute on function public.teller_provision_intercompany_accounts(uuid, uuid, uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Pair balance helper (reconciliation — no auto-balancing)
-- ---------------------------------------------------------------------------

create or replace function public.teller_intercompany_pair_balances(
  p_organization_id uuid,
  p_entity_a_id uuid,
  p_entity_b_id uuid,
  p_as_of date default current_date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_a_from uuid;
  v_a_to uuid;
  v_b_from uuid;
  v_b_to uuid;
  v_a_due_from_b numeric(14, 2) := 0;
  v_a_due_to_b numeric(14, 2) := 0;
  v_b_due_from_a numeric(14, 2) := 0;
  v_b_due_to_a numeric(14, 2) := 0;
begin
  perform public.teller_assert_entity_belongs_to_org(p_organization_id, p_entity_a_id);
  perform public.teller_assert_entity_belongs_to_org(p_organization_id, p_entity_b_id);

  select due_from_account_id, due_to_account_id
  into v_a_from, v_a_to
  from public.teller_intercompany_account_pairs
  where owner_legal_entity_id = p_entity_a_id
    and counterparty_legal_entity_id = p_entity_b_id;

  select due_from_account_id, due_to_account_id
  into v_b_from, v_b_to
  from public.teller_intercompany_account_pairs
  where owner_legal_entity_id = p_entity_b_id
    and counterparty_legal_entity_id = p_entity_a_id;

  if v_a_from is not null then
    select coalesce(sum(jl.debit - jl.credit), 0) into v_a_due_from_b
    from public.teller_journal_lines jl
    join public.teller_journal_entries je on je.id = jl.entry_id
    where je.organization_id = p_organization_id
      and je.legal_entity_id = p_entity_a_id
      and je.entry_date <= p_as_of
      and jl.account_id = v_a_from;
  end if;

  if v_a_to is not null then
    select coalesce(sum(jl.credit - jl.debit), 0) into v_a_due_to_b
    from public.teller_journal_lines jl
    join public.teller_journal_entries je on je.id = jl.entry_id
    where je.organization_id = p_organization_id
      and je.legal_entity_id = p_entity_a_id
      and je.entry_date <= p_as_of
      and jl.account_id = v_a_to;
  end if;

  if v_b_from is not null then
    select coalesce(sum(jl.debit - jl.credit), 0) into v_b_due_from_a
    from public.teller_journal_lines jl
    join public.teller_journal_entries je on je.id = jl.entry_id
    where je.organization_id = p_organization_id
      and je.legal_entity_id = p_entity_b_id
      and je.entry_date <= p_as_of
      and jl.account_id = v_b_from;
  end if;

  if v_b_to is not null then
    select coalesce(sum(jl.credit - jl.debit), 0) into v_b_due_to_a
    from public.teller_journal_lines jl
    join public.teller_journal_entries je on je.id = jl.entry_id
    where je.organization_id = p_organization_id
      and je.legal_entity_id = p_entity_b_id
      and je.entry_date <= p_as_of
      and jl.account_id = v_b_to;
  end if;

  return jsonb_build_object(
    'entity_a_id', p_entity_a_id,
    'entity_b_id', p_entity_b_id,
    'a_due_from_b', v_a_due_from_b,
    'a_due_to_b', v_a_due_to_b,
    'b_due_from_a', v_b_due_from_a,
    'b_due_to_a', v_b_due_to_a,
    'receivable_payable_difference', v_a_due_from_b - v_b_due_to_a,
    'payable_receivable_difference', v_a_due_to_b - v_b_due_from_a,
    'balanced',
      abs(v_a_due_from_b - v_b_due_to_a) < 0.01
      and abs(v_a_due_to_b - v_b_due_from_a) < 0.01
  );
end;
$$;

grant execute on function public.teller_intercompany_pair_balances(uuid, uuid, uuid, date)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Atomic intercompany posting — both journals or neither
-- ---------------------------------------------------------------------------

create or replace function public.teller_atomic_post_intercompany(
  p_organization_id uuid,
  p_source_legal_entity_id uuid,
  p_counterparty_legal_entity_id uuid,
  p_transaction_type text,
  p_entry_date date,
  p_amount numeric,
  p_description text,
  p_reference text,
  p_source_lines jsonb,
  p_counterparty_lines jsonb,
  p_idempotency_key text default null,
  p_external_event_id text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_actor_id uuid default null,
  p_simulate_failure_after text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_existing public.teller_intercompany_transactions%rowtype;
  v_tx_id uuid;
  v_source_journal_id uuid;
  v_counterparty_journal_id uuid;
  v_closed_source date;
  v_closed_counterparty date;
begin
  if auth.uid() is not null and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to post intercompany transaction';
  end if;

  if p_source_legal_entity_id = p_counterparty_legal_entity_id then
    raise exception 'Intercompany transaction requires distinct legal entities';
  end if;

  perform public.teller_assert_entity_belongs_to_org(p_organization_id, p_source_legal_entity_id);
  perform public.teller_assert_entity_belongs_to_org(p_organization_id, p_counterparty_legal_entity_id);

  if auth.uid() is not null then
    if not public.teller_can_access_legal_entity(p_organization_id, p_source_legal_entity_id) then
      raise exception 'Not authorized for source legal entity';
    end if;
    if not public.teller_can_access_legal_entity(p_organization_id, p_counterparty_legal_entity_id) then
      raise exception 'Not authorized for counterparty legal entity';
    end if;
  end if;

  perform public.teller_acquire_org_accounting_lock(p_organization_id);

  if p_idempotency_key is not null and length(trim(p_idempotency_key)) > 0 then
    select * into v_existing
    from public.teller_intercompany_transactions
    where organization_id = p_organization_id
      and idempotency_key = p_idempotency_key;

    if found then
      return jsonb_build_object(
        'duplicate', true,
        'intercompany_transaction_id', v_existing.id,
        'source_journal_id', v_existing.source_journal_id,
        'counterparty_journal_id', v_existing.counterparty_journal_id
      );
    end if;
  end if;

  v_closed_source := public.teller_books_closed_through(p_organization_id, p_source_legal_entity_id);
  if v_closed_source is not null and p_entry_date <= v_closed_source then
    raise exception 'Source entity accounting period is closed through %', v_closed_source;
  end if;

  v_closed_counterparty := public.teller_books_closed_through(
    p_organization_id,
    p_counterparty_legal_entity_id
  );
  if v_closed_counterparty is not null and p_entry_date <= v_closed_counterparty then
    raise exception 'Counterparty entity accounting period is closed through %', v_closed_counterparty;
  end if;

  insert into public.teller_intercompany_transactions (
    organization_id,
    source_legal_entity_id,
    counterparty_legal_entity_id,
    transaction_type,
    transaction_date,
    description,
    reference,
    amount,
    status,
    idempotency_key,
    external_event_id,
    metadata,
    created_by
  ) values (
    p_organization_id,
    p_source_legal_entity_id,
    p_counterparty_legal_entity_id,
    p_transaction_type,
    p_entry_date,
    coalesce(p_description, ''),
    p_reference,
    p_amount,
    'pending',
    nullif(trim(p_idempotency_key), ''),
    p_external_event_id,
    coalesce(p_metadata, '{}'::jsonb),
    coalesce(p_actor_id, auth.uid())
  )
  returning id into v_tx_id;

  if p_simulate_failure_after = 'before_journals' then
    raise exception 'Simulated failure before intercompany journal creation';
  end if;

  v_source_journal_id := public.teller_post_journal(
    p_organization_id,
    p_source_legal_entity_id,
    p_entry_date,
    coalesce(p_description, 'Intercompany'),
    'intercompany',
    v_tx_id,
    null,
    p_source_lines
  );

  if p_simulate_failure_after = 'after_source_journal' then
    raise exception 'Simulated failure after source intercompany journal';
  end if;

  v_counterparty_journal_id := public.teller_post_journal(
    p_organization_id,
    p_counterparty_legal_entity_id,
    p_entry_date,
    coalesce(p_description, 'Intercompany'),
    'intercompany',
    v_tx_id,
    null,
    p_counterparty_lines
  );

  if p_simulate_failure_after = 'after_counterparty_journal' then
    raise exception 'Simulated failure after counterparty intercompany journal';
  end if;

  update public.teller_intercompany_transactions
  set
    source_journal_id = v_source_journal_id,
    counterparty_journal_id = v_counterparty_journal_id,
    status = 'posted'
  where id = v_tx_id;

  return jsonb_build_object(
    'duplicate', false,
    'intercompany_transaction_id', v_tx_id,
    'source_journal_id', v_source_journal_id,
    'counterparty_journal_id', v_counterparty_journal_id
  );
end;
$$;

grant execute on function public.teller_atomic_post_intercompany(
  uuid, uuid, uuid, text, date, numeric, text, text, jsonb, jsonb, text, text, jsonb, uuid, text
) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Atomic intercompany reversal — paired reversal journals
-- ---------------------------------------------------------------------------

create or replace function public.teller_atomic_reverse_intercompany(
  p_organization_id uuid,
  p_intercompany_transaction_id uuid,
  p_reversal_date date,
  p_memo text,
  p_actor_id uuid default null,
  p_simulate_failure_after text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_original public.teller_intercompany_transactions%rowtype;
  v_reversal_id uuid;
  v_source_reversal uuid;
  v_counterparty_reversal uuid;
  v_source_lines jsonb;
  v_counterparty_lines jsonb;
  v_line record;
begin
  if auth.uid() is not null and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to reverse intercompany transaction';
  end if;

  select * into v_original
  from public.teller_intercompany_transactions
  where id = p_intercompany_transaction_id
    and organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'Intercompany transaction not found';
  end if;

  if v_original.status = 'reversed' then
    return jsonb_build_object(
      'duplicate', true,
      'reversal_transaction_id', v_original.reversal_transaction_id
    );
  end if;

  if auth.uid() is not null then
    if not public.teller_can_access_legal_entity(p_organization_id, v_original.source_legal_entity_id) then
      raise exception 'Not authorized for source legal entity';
    end if;
    if not public.teller_can_access_legal_entity(p_organization_id, v_original.counterparty_legal_entity_id) then
      raise exception 'Not authorized for counterparty legal entity';
    end if;
  end if;

  perform public.teller_acquire_org_accounting_lock(p_organization_id);

  if public.teller_books_closed_through(p_organization_id, v_original.source_legal_entity_id) is not null
     and p_reversal_date <= public.teller_books_closed_through(
       p_organization_id,
       v_original.source_legal_entity_id
     ) then
    raise exception 'Source entity accounting period is closed for reversal date';
  end if;

  if public.teller_books_closed_through(p_organization_id, v_original.counterparty_legal_entity_id) is not null
     and p_reversal_date <= public.teller_books_closed_through(
       p_organization_id,
       v_original.counterparty_legal_entity_id
     ) then
    raise exception 'Counterparty entity accounting period is closed for reversal date';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'account_id', jl.account_id,
      'debit', jl.credit,
      'credit', jl.debit,
      'party_id', jl.party_id,
      'job_id', jl.job_id,
      'job_cost_category_id', jl.job_cost_category_id,
      'cost_classification', coalesce(jl.cost_classification, ''),
      'fixed_asset_id', jl.fixed_asset_id,
      'memo', coalesce('Reversal: ' || jl.memo, 'Reversal')
    )
  ), '[]'::jsonb)
  into v_source_lines
  from public.teller_journal_lines jl
  where jl.entry_id = v_original.source_journal_id;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'account_id', jl.account_id,
      'debit', jl.credit,
      'credit', jl.debit,
      'party_id', jl.party_id,
      'job_id', jl.job_id,
      'job_cost_category_id', jl.job_cost_category_id,
      'cost_classification', coalesce(jl.cost_classification, ''),
      'fixed_asset_id', jl.fixed_asset_id,
      'memo', coalesce('Reversal: ' || jl.memo, 'Reversal')
    )
  ), '[]'::jsonb)
  into v_counterparty_lines
  from public.teller_journal_lines jl
  where jl.entry_id = v_original.counterparty_journal_id;

  insert into public.teller_intercompany_transactions (
    organization_id,
    source_legal_entity_id,
    counterparty_legal_entity_id,
    transaction_type,
    transaction_date,
    description,
    reference,
    amount,
    status,
    reverses_transaction_id,
    created_by
  ) values (
    p_organization_id,
    v_original.source_legal_entity_id,
    v_original.counterparty_legal_entity_id,
    v_original.transaction_type,
    p_reversal_date,
    coalesce(p_memo, 'Reversal'),
    v_original.reference,
    v_original.amount,
    'pending',
    v_original.id,
    coalesce(p_actor_id, auth.uid())
  )
  returning id into v_reversal_id;

  if p_simulate_failure_after = 'before_journals' then
    raise exception 'Simulated failure before intercompany reversal journals';
  end if;

  v_source_reversal := public.teller_post_journal(
    p_organization_id,
    v_original.source_legal_entity_id,
    p_reversal_date,
    coalesce(p_memo, 'Intercompany reversal'),
    'intercompany-reversal',
    v_reversal_id,
    v_original.source_journal_id,
    v_source_lines
  );

  if p_simulate_failure_after = 'after_source_journal' then
    raise exception 'Simulated failure after source intercompany reversal journal';
  end if;

  v_counterparty_reversal := public.teller_post_journal(
    p_organization_id,
    v_original.counterparty_legal_entity_id,
    p_reversal_date,
    coalesce(p_memo, 'Intercompany reversal'),
    'intercompany-reversal',
    v_reversal_id,
    v_original.counterparty_journal_id,
    v_counterparty_lines
  );

  update public.teller_intercompany_transactions
  set
    source_journal_id = v_source_reversal,
    counterparty_journal_id = v_counterparty_reversal,
    status = 'posted'
  where id = v_reversal_id;

  update public.teller_intercompany_transactions
  set
    status = 'reversed',
    reversal_transaction_id = v_reversal_id,
    reversed_at = now(),
    reversed_by = coalesce(p_actor_id, auth.uid())
  where id = v_original.id;

  return jsonb_build_object(
    'duplicate', false,
    'reversal_transaction_id', v_reversal_id,
    'source_reversal_journal_id', v_source_reversal,
    'counterparty_reversal_journal_id', v_counterparty_reversal,
    'original_transaction_id', v_original.id
  );
end;
$$;

grant execute on function public.teller_atomic_reverse_intercompany(
  uuid, uuid, date, text, uuid, text
) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS — org boundary + entity access (no permissive OR widening)
-- ---------------------------------------------------------------------------

alter table public.teller_intercompany_account_pairs enable row level security;
alter table public.teller_intercompany_transactions enable row level security;

create policy "teller members read intercompany account pairs"
  on public.teller_intercompany_account_pairs for select
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_access_legal_entity(organization_id, owner_legal_entity_id)
  );

create policy "teller members read intercompany transactions"
  on public.teller_intercompany_transactions for select
  using (
    public.teller_is_org_member(organization_id)
    and (
      public.teller_can_access_legal_entity(organization_id, source_legal_entity_id)
      or public.teller_can_access_legal_entity(organization_id, counterparty_legal_entity_id)
    )
  );

-- Writes via security definer RPCs only (no direct INSERT/UPDATE policies)
