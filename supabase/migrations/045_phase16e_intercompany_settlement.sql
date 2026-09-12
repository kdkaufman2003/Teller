-- Phase 16E: Intercompany settlement + reconciliation on Phase 16D balances.
-- Manual apply only. Does NOT implement consolidation eliminations (16F–16G).
-- Settlement clears due-to/due-from — no revenue, expense, or sales tax.

-- ---------------------------------------------------------------------------
-- Settlement record (paired payer/payee journals)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_intercompany_settlements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  payer_legal_entity_id uuid not null references public.teller_legal_entities (id) on delete restrict,
  payee_legal_entity_id uuid not null references public.teller_legal_entities (id) on delete restrict,
  settlement_date date not null,
  amount numeric(14, 2) not null check (amount > 0),
  currency text not null default 'USD',
  status text not null default 'draft'
    check (status in ('draft', 'posted', 'partially_reconciled', 'reconciled', 'reversed')),
  settlement_mode text not null default 'itemized'
    check (settlement_mode in ('itemized', 'net')),
  payer_bank_account_id uuid references public.teller_bank_accounts (id) on delete restrict,
  payee_bank_account_id uuid references public.teller_bank_accounts (id) on delete restrict,
  payer_cash_account_id uuid not null references public.teller_accounts (id) on delete restrict,
  payee_cash_account_id uuid not null references public.teller_accounts (id) on delete restrict,
  payer_journal_id uuid references public.teller_journal_entries (id) on delete restrict,
  payee_journal_id uuid references public.teller_journal_entries (id) on delete restrict,
  reference text,
  memo text not null default '',
  idempotency_key text,
  bank_match_status text not null default 'unmatched'
    check (bank_match_status in ('unmatched', 'partially_matched', 'matched')),
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  posted_at timestamptz,
  reverses_settlement_id uuid references public.teller_intercompany_settlements (id) on delete restrict,
  reversal_settlement_id uuid references public.teller_intercompany_settlements (id) on delete restrict,
  reversed_at timestamptz,
  reversed_by uuid references auth.users (id) on delete set null,
  constraint teller_ic_settlement_entities_distinct check (
    payer_legal_entity_id <> payee_legal_entity_id
  ),
  constraint teller_ic_settlement_journals_required_when_posted check (
    status <> 'posted'
    or (payer_journal_id is not null and payee_journal_id is not null)
  )
);

create unique index if not exists teller_ic_settlement_idempotency_uidx
  on public.teller_intercompany_settlements (organization_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists teller_ic_settlement_org_date_idx
  on public.teller_intercompany_settlements (organization_id, settlement_date desc);

create index if not exists teller_ic_settlement_payer_idx
  on public.teller_intercompany_settlements (organization_id, payer_legal_entity_id);

create index if not exists teller_ic_settlement_payee_idx
  on public.teller_intercompany_settlements (organization_id, payee_legal_entity_id);

-- ---------------------------------------------------------------------------
-- Settlement allocations (allocation truth for open balances)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_intercompany_settlement_allocations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  settlement_id uuid not null references public.teller_intercompany_settlements (id) on delete restrict,
  intercompany_transaction_id uuid not null references public.teller_intercompany_transactions (id) on delete restrict,
  amount_applied numeric(14, 2) not null check (amount_applied > 0),
  created_at timestamptz not null default now(),
  constraint teller_ic_settlement_alloc_settlement_tx_uidx unique (
    settlement_id,
    intercompany_transaction_id
  )
);

create index if not exists teller_ic_settlement_alloc_tx_idx
  on public.teller_intercompany_settlement_allocations (intercompany_transaction_id);

create index if not exists teller_ic_settlement_alloc_settlement_idx
  on public.teller_intercompany_settlement_allocations (settlement_id);

-- ---------------------------------------------------------------------------
-- Immutability — posted settlements cannot be edited; corrections via reversal
-- ---------------------------------------------------------------------------

create or replace function public.teller_intercompany_settlement_immutable()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    if old.status in ('posted', 'partially_reconciled', 'reconciled', 'reversed') then
      if new.payer_legal_entity_id is distinct from old.payer_legal_entity_id
         or new.payee_legal_entity_id is distinct from old.payee_legal_entity_id
         or new.amount is distinct from old.amount
         or new.settlement_date is distinct from old.settlement_date
         or new.payer_cash_account_id is distinct from old.payer_cash_account_id
         or new.payee_cash_account_id is distinct from old.payee_cash_account_id
         or new.payer_journal_id is distinct from old.payer_journal_id
         or new.payee_journal_id is distinct from old.payee_journal_id
         or new.idempotency_key is distinct from old.idempotency_key then
        raise exception 'Posted intercompany settlement cannot be modified';
      end if;
      if new.status = 'reversed'
         and old.status in ('posted', 'partially_reconciled', 'reconciled')
         and new.reversal_settlement_id is not null then
        return new;
      end if;
      if old.status in ('posted', 'partially_reconciled', 'reconciled')
         and new.status is distinct from old.status
         and new.status not in ('partially_reconciled', 'reconciled', 'reversed') then
        raise exception 'Posted intercompany settlement cannot be modified';
      end if;
    end if;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Intercompany settlements cannot be deleted';
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists teller_intercompany_settlement_immutable
  on public.teller_intercompany_settlements;
create trigger teller_intercompany_settlement_immutable
  before update or delete on public.teller_intercompany_settlements
  for each row execute function public.teller_intercompany_settlement_immutable();

-- ---------------------------------------------------------------------------
-- Open balance helpers (allocation truth — not mutable cached fields)
-- ---------------------------------------------------------------------------

create or replace function public.teller_intercompany_tx_settled_amount(
  p_intercompany_transaction_id uuid,
  p_as_of date default null
)
returns numeric
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(sum(a.amount_applied), 0)
  from public.teller_intercompany_settlement_allocations a
  join public.teller_intercompany_settlements s on s.id = a.settlement_id
  where a.intercompany_transaction_id = p_intercompany_transaction_id
    and s.status in ('posted', 'partially_reconciled', 'reconciled')
    and s.reverses_settlement_id is null
    and (p_as_of is null or s.settlement_date <= p_as_of);
$$;

grant execute on function public.teller_intercompany_tx_settled_amount(uuid, date)
  to authenticated, service_role;

create or replace function public.teller_intercompany_tx_open_balance(
  p_intercompany_transaction_id uuid,
  p_as_of date default null
)
returns numeric
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_tx public.teller_intercompany_transactions%rowtype;
  v_settled numeric(14, 2);
begin
  select * into v_tx
  from public.teller_intercompany_transactions
  where id = p_intercompany_transaction_id;

  if not found or v_tx.status <> 'posted' then
    return 0;
  end if;

  v_settled := public.teller_intercompany_tx_settled_amount(p_intercompany_transaction_id, p_as_of);
  return greatest(v_tx.amount - v_settled, 0);
end;
$$;

grant execute on function public.teller_intercompany_tx_open_balance(uuid, date)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Resolve entity cash account (server-side — never trust client GL IDs)
-- ---------------------------------------------------------------------------

create or replace function public.teller_resolve_entity_cash_account(
  p_organization_id uuid,
  p_legal_entity_id uuid,
  p_bank_account_id uuid default null
)
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_gl uuid;
begin
  perform public.teller_assert_entity_belongs_to_org(p_organization_id, p_legal_entity_id);

  if p_bank_account_id is not null then
    select ba.teller_account_id into v_gl
    from public.teller_bank_accounts ba
    where ba.id = p_bank_account_id
      and ba.organization_id = p_organization_id
      and ba.legal_entity_id = p_legal_entity_id;

    if v_gl is null then
      raise exception 'Bank account does not belong to the specified legal entity';
    end if;
    return v_gl;
  end if;

  select a.id into v_gl
  from public.teller_accounts a
  where a.organization_id = p_organization_id
    and a.legal_entity_id = p_legal_entity_id
    and a.subtype = 'bank'
  order by a.code
  limit 1;

  if v_gl is null then
    select a.id into v_gl
    from public.teller_accounts a
    where a.organization_id = p_organization_id
      and a.legal_entity_id = p_legal_entity_id
      and a.code = '1000'
    limit 1;
  end if;

  if v_gl is null then
    raise exception 'No cash account found for legal entity';
  end if;

  return v_gl;
end;
$$;

grant execute on function public.teller_resolve_entity_cash_account(uuid, uuid, uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Open items for entity pair (as-of aware)
-- ---------------------------------------------------------------------------

create or replace function public.teller_intercompany_open_items(
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
  v_items jsonb := '[]'::jsonb;
  v_row record;
  v_open numeric(14, 2);
begin
  perform public.teller_assert_entity_belongs_to_org(p_organization_id, p_entity_a_id);
  perform public.teller_assert_entity_belongs_to_org(p_organization_id, p_entity_b_id);

  for v_row in
    select
      ic.id,
      ic.transaction_date,
      ic.transaction_type,
      ic.reference,
      ic.description,
      ic.amount,
      ic.currency,
      ic.status,
      ic.source_legal_entity_id,
      ic.counterparty_legal_entity_id,
      ic.source_journal_id,
      ic.counterparty_journal_id
    from public.teller_intercompany_transactions ic
    where ic.organization_id = p_organization_id
      and ic.status = 'posted'
      and ic.transaction_date <= p_as_of
      and (
        (ic.source_legal_entity_id = p_entity_a_id and ic.counterparty_legal_entity_id = p_entity_b_id)
        or (ic.source_legal_entity_id = p_entity_b_id and ic.counterparty_legal_entity_id = p_entity_a_id)
      )
    order by ic.transaction_date asc, ic.created_at asc
  loop
    v_open := public.teller_intercompany_tx_open_balance(v_row.id, p_as_of);
    if v_open > 0.009 then
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'intercompany_transaction_id', v_row.id,
        'transaction_date', v_row.transaction_date,
        'transaction_type', v_row.transaction_type,
        'reference', v_row.reference,
        'description', v_row.description,
        'original_amount', v_row.amount,
        'settled_amount', v_row.amount - v_open,
        'remaining_amount', v_open,
        'source_legal_entity_id', v_row.source_legal_entity_id,
        'counterparty_legal_entity_id', v_row.counterparty_legal_entity_id,
        'source_journal_id', v_row.source_journal_id,
        'counterparty_journal_id', v_row.counterparty_journal_id,
        'status', 'open'
      ));
    end if;
  end loop;

  return v_items;
end;
$$;

grant execute on function public.teller_intercompany_open_items(uuid, uuid, uuid, date)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Pair reconciliation report (gross + net + status — no auto-balancing)
-- ---------------------------------------------------------------------------

create or replace function public.teller_intercompany_pair_reconciliation(
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
  v_balances jsonb;
  v_a_due_from_b numeric(14, 2);
  v_a_due_to_b numeric(14, 2);
  v_b_due_from_a numeric(14, 2);
  v_b_due_to_a numeric(14, 2);
  v_open_items jsonb;
  v_open_count int;
  v_settled_period numeric(14, 2) := 0;
  v_last_activity date;
  v_status text;
  v_net_a_owes_b numeric(14, 2);
  v_net_b_owes_a numeric(14, 2);
begin
  v_balances := public.teller_intercompany_pair_balances(
    p_organization_id,
    p_entity_a_id,
    p_entity_b_id,
    p_as_of
  );

  v_a_due_from_b := (v_balances->>'a_due_from_b')::numeric;
  v_a_due_to_b := (v_balances->>'a_due_to_b')::numeric;
  v_b_due_from_a := (v_balances->>'b_due_from_a')::numeric;
  v_b_due_to_a := (v_balances->>'b_due_to_a')::numeric;

  v_open_items := public.teller_intercompany_open_items(
    p_organization_id,
    p_entity_a_id,
    p_entity_b_id,
    p_as_of
  );
  v_open_count := jsonb_array_length(v_open_items);

  select coalesce(sum(s.amount), 0) into v_settled_period
  from public.teller_intercompany_settlements s
  where s.organization_id = p_organization_id
    and s.status in ('posted', 'partially_reconciled', 'reconciled')
    and s.settlement_date <= p_as_of
    and (
      (s.payer_legal_entity_id = p_entity_a_id and s.payee_legal_entity_id = p_entity_b_id)
      or (s.payer_legal_entity_id = p_entity_b_id and s.payee_legal_entity_id = p_entity_a_id)
    );

  select max(combined.transaction_date) into v_last_activity
  from (
    select transaction_date from public.teller_intercompany_transactions
    where organization_id = p_organization_id
      and transaction_date <= p_as_of
      and (
        (source_legal_entity_id = p_entity_a_id and counterparty_legal_entity_id = p_entity_b_id)
        or (source_legal_entity_id = p_entity_b_id and counterparty_legal_entity_id = p_entity_a_id)
      )
    union all
    select settlement_date from public.teller_intercompany_settlements
    where organization_id = p_organization_id
      and settlement_date <= p_as_of
      and status in ('posted', 'partially_reconciled', 'reconciled')
      and (
        (payer_legal_entity_id = p_entity_a_id and payee_legal_entity_id = p_entity_b_id)
        or (payer_legal_entity_id = p_entity_b_id and payee_legal_entity_id = p_entity_a_id)
      )
  ) combined(transaction_date);

  v_net_a_owes_b := greatest(v_a_due_to_b - v_b_due_from_a, 0);
  v_net_b_owes_a := greatest(v_b_due_to_a - v_a_due_from_b, 0);

  if abs(v_a_due_from_b - v_b_due_to_a) < 0.01
     and abs(v_a_due_to_b - v_b_due_from_a) < 0.01
     and v_open_count = 0 then
    v_status := 'RECONCILED';
  elsif abs(v_a_due_from_b - v_b_due_to_a) >= 0.01
     or abs(v_a_due_to_b - v_b_due_from_a) >= 0.01 then
    v_status := 'OUT_OF_BALANCE';
  elsif v_open_count > 0 then
    v_status := 'OPEN_BALANCE';
  else
    v_status := 'PENDING_REVIEW';
  end if;

  return jsonb_build_object(
    'entity_a_id', p_entity_a_id,
    'entity_b_id', p_entity_b_id,
    'as_of', p_as_of,
    'a_due_from_b', v_a_due_from_b,
    'a_due_to_b', v_a_due_to_b,
    'b_due_from_a', v_b_due_from_a,
    'b_due_to_a', v_b_due_to_a,
    'receivable_payable_difference', v_a_due_from_b - v_b_due_to_a,
    'payable_receivable_difference', v_a_due_to_b - v_b_due_from_a,
    'net_a_owes_b', v_net_a_owes_b,
    'net_b_owes_a', v_net_b_owes_a,
    'balanced', abs(v_a_due_from_b - v_b_due_to_a) < 0.01
      and abs(v_a_due_to_b - v_b_due_from_a) < 0.01,
    'open_balance', v_net_a_owes_b + v_net_b_owes_a,
    'settled_during_period', v_settled_period,
    'open_items_count', v_open_count,
    'open_items', v_open_items,
    'last_activity', v_last_activity,
    'status', v_status
  );
end;
$$;

grant execute on function public.teller_intercompany_pair_reconciliation(uuid, uuid, uuid, date)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Bank match resource type foundation (defer automatic matching to future)
-- ---------------------------------------------------------------------------

alter table public.teller_bank_matches
  drop constraint if exists teller_bank_matches_resource_type_check;

alter table public.teller_bank_matches
  add constraint teller_bank_matches_resource_type_check check (matched_resource_type in (
    'customer_payment',
    'bill_payment',
    'expense_payment',
    'customer_deposit',
    'deposit_refund',
    'credit_refund',
    'payment_reversal',
    'bank_transfer',
    'journal_entry',
    'bank_fee',
    'interest_income',
    'interest_expense',
    'owner_contribution',
    'owner_draw',
    'document',
    'intercompany_settlement'
  ));

-- ---------------------------------------------------------------------------
-- Atomic settlement posting — both journals or neither
-- Phase 16E model: posted settlement assumes cash transfer completed (no pending clearing)
-- ---------------------------------------------------------------------------

create or replace function public.teller_atomic_post_intercompany_settlement(
  p_organization_id uuid,
  p_payer_legal_entity_id uuid,
  p_payee_legal_entity_id uuid,
  p_settlement_date date,
  p_amount numeric,
  p_reference text,
  p_memo text,
  p_allocations jsonb,
  p_payer_bank_account_id uuid default null,
  p_payee_bank_account_id uuid default null,
  p_settlement_mode text default 'itemized',
  p_idempotency_key text default null,
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
  v_existing public.teller_intercompany_settlements%rowtype;
  v_settlement_id uuid;
  v_payer_cash uuid;
  v_payee_cash uuid;
  v_payer_due_to uuid;
  v_payee_due_from uuid;
  v_payer_journal_id uuid;
  v_payee_journal_id uuid;
  v_alloc record;
  v_alloc_sum numeric(14, 2) := 0;
  v_open numeric(14, 2);
  v_ic_tx public.teller_intercompany_transactions%rowtype;
  v_closed_payer date;
  v_closed_payee date;
  v_payer_lines jsonb;
  v_payee_lines jsonb;
begin
  if auth.uid() is not null and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to post intercompany settlement';
  end if;

  if p_payer_legal_entity_id = p_payee_legal_entity_id then
    raise exception 'Intercompany settlement requires distinct legal entities';
  end if;

  perform public.teller_assert_entity_belongs_to_org(p_organization_id, p_payer_legal_entity_id);
  perform public.teller_assert_entity_belongs_to_org(p_organization_id, p_payee_legal_entity_id);

  if auth.uid() is not null then
    if not public.teller_can_access_legal_entity(p_organization_id, p_payer_legal_entity_id) then
      raise exception 'Not authorized for payer legal entity';
    end if;
    if not public.teller_can_access_legal_entity(p_organization_id, p_payee_legal_entity_id) then
      raise exception 'Not authorized for payee legal entity';
    end if;
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'Settlement amount must be positive';
  end if;

  perform public.teller_acquire_org_accounting_lock(p_organization_id);

  if p_idempotency_key is not null and length(trim(p_idempotency_key)) > 0 then
    select * into v_existing
    from public.teller_intercompany_settlements
    where organization_id = p_organization_id
      and idempotency_key = p_idempotency_key;

    if found then
      return jsonb_build_object(
        'duplicate', true,
        'settlement_id', v_existing.id,
        'payer_journal_id', v_existing.payer_journal_id,
        'payee_journal_id', v_existing.payee_journal_id
      );
    end if;
  end if;

  v_closed_payer := public.teller_books_closed_through(p_organization_id, p_payer_legal_entity_id);
  if v_closed_payer is not null and p_settlement_date <= v_closed_payer then
    raise exception 'Payer entity accounting period is closed through %', v_closed_payer;
  end if;

  v_closed_payee := public.teller_books_closed_through(p_organization_id, p_payee_legal_entity_id);
  if v_closed_payee is not null and p_settlement_date <= v_closed_payee then
    raise exception 'Payee entity accounting period is closed through %', v_closed_payee;
  end if;

  v_payer_cash := public.teller_resolve_entity_cash_account(
    p_organization_id,
    p_payer_legal_entity_id,
    p_payer_bank_account_id
  );
  v_payee_cash := public.teller_resolve_entity_cash_account(
    p_organization_id,
    p_payee_legal_entity_id,
    p_payee_bank_account_id
  );

  if p_payer_bank_account_id is not null then
    if not exists (
      select 1 from public.teller_bank_accounts
      where id = p_payer_bank_account_id
        and organization_id = p_organization_id
        and legal_entity_id = p_payer_legal_entity_id
    ) then
      raise exception 'Payer bank account belongs to wrong legal entity';
    end if;
  end if;

  if p_payee_bank_account_id is not null then
    if not exists (
      select 1 from public.teller_bank_accounts
      where id = p_payee_bank_account_id
        and organization_id = p_organization_id
        and legal_entity_id = p_payee_legal_entity_id
    ) then
      raise exception 'Payee bank account belongs to wrong legal entity';
    end if;
  end if;

  for v_alloc in
    select *
    from jsonb_to_recordset(coalesce(p_allocations, '[]'::jsonb)) as x(
      intercompany_transaction_id uuid,
      amount_applied numeric
    )
  loop
    if v_alloc.amount_applied is null or v_alloc.amount_applied <= 0 then
      raise exception 'Allocation amount must be positive';
    end if;

    select * into v_ic_tx
    from public.teller_intercompany_transactions
    where id = v_alloc.intercompany_transaction_id
      and organization_id = p_organization_id;

    if not found then
      raise exception 'Intercompany transaction not found for allocation';
    end if;

    if v_ic_tx.status <> 'posted' then
      raise exception 'Cannot allocate to non-posted intercompany transaction';
    end if;

    if not (
      (v_ic_tx.source_legal_entity_id = p_payer_legal_entity_id
       and v_ic_tx.counterparty_legal_entity_id = p_payee_legal_entity_id)
      or (v_ic_tx.source_legal_entity_id = p_payee_legal_entity_id
          and v_ic_tx.counterparty_legal_entity_id = p_payer_legal_entity_id)
    ) then
      raise exception 'Allocation intercompany transaction does not match entity pair';
    end if;

    v_open := public.teller_intercompany_tx_open_balance(v_ic_tx.id, null);
    if v_alloc.amount_applied > v_open + 0.009 then
      raise exception 'Allocation over-applies intercompany transaction %', v_ic_tx.id;
    end if;

    v_alloc_sum := v_alloc_sum + v_alloc.amount_applied;
  end loop;

  if abs(v_alloc_sum - p_amount) > 0.009 then
    raise exception 'Settlement amount must equal sum of allocations';
  end if;

  if jsonb_array_length(coalesce(p_allocations, '[]'::jsonb)) = 0 then
    raise exception 'At least one allocation is required';
  end if;

  perform public.teller_provision_intercompany_accounts(
    p_organization_id,
    p_payer_legal_entity_id,
    p_payee_legal_entity_id
  );
  perform public.teller_provision_intercompany_accounts(
    p_organization_id,
    p_payee_legal_entity_id,
    p_payer_legal_entity_id
  );

  select due_to_account_id into v_payer_due_to
  from public.teller_intercompany_account_pairs
  where owner_legal_entity_id = p_payer_legal_entity_id
    and counterparty_legal_entity_id = p_payee_legal_entity_id;

  select due_from_account_id into v_payee_due_from
  from public.teller_intercompany_account_pairs
  where owner_legal_entity_id = p_payee_legal_entity_id
    and counterparty_legal_entity_id = p_payer_legal_entity_id;

  if v_payer_due_to is null or v_payee_due_from is null then
    raise exception 'Intercompany due accounts not provisioned';
  end if;

  insert into public.teller_intercompany_settlements (
    organization_id,
    payer_legal_entity_id,
    payee_legal_entity_id,
    settlement_date,
    amount,
    status,
    settlement_mode,
    payer_bank_account_id,
    payee_bank_account_id,
    payer_cash_account_id,
    payee_cash_account_id,
    reference,
    memo,
    idempotency_key,
    metadata,
    created_by
  ) values (
    p_organization_id,
    p_payer_legal_entity_id,
    p_payee_legal_entity_id,
    p_settlement_date,
    p_amount,
    'draft',
    coalesce(nullif(trim(p_settlement_mode), ''), 'itemized'),
    p_payer_bank_account_id,
    p_payee_bank_account_id,
    v_payer_cash,
    v_payee_cash,
    p_reference,
    coalesce(p_memo, ''),
    nullif(trim(p_idempotency_key), ''),
    coalesce(p_metadata, '{}'::jsonb),
    coalesce(p_actor_id, auth.uid())
  )
  returning id into v_settlement_id;

  for v_alloc in
    select *
    from jsonb_to_recordset(coalesce(p_allocations, '[]'::jsonb)) as x(
      intercompany_transaction_id uuid,
      amount_applied numeric
    )
  loop
    insert into public.teller_intercompany_settlement_allocations (
      organization_id,
      settlement_id,
      intercompany_transaction_id,
      amount_applied
    ) values (
      p_organization_id,
      v_settlement_id,
      v_alloc.intercompany_transaction_id,
      v_alloc.amount_applied
    );
  end loop;

  if p_simulate_failure_after = 'before_journals' then
    raise exception 'Simulated failure before settlement journal creation';
  end if;

  v_payer_lines := jsonb_build_array(
    jsonb_build_object(
      'account_id', v_payer_due_to,
      'debit', p_amount,
      'credit', 0,
      'party_id', null,
      'job_id', null,
      'job_cost_category_id', null,
      'cost_classification', '',
      'fixed_asset_id', null,
      'memo', coalesce(p_memo, 'Intercompany settlement')
    ),
    jsonb_build_object(
      'account_id', v_payer_cash,
      'debit', 0,
      'credit', p_amount,
      'party_id', null,
      'job_id', null,
      'job_cost_category_id', null,
      'cost_classification', '',
      'fixed_asset_id', null,
      'memo', coalesce(p_memo, 'Intercompany settlement')
    )
  );

  v_payee_lines := jsonb_build_array(
    jsonb_build_object(
      'account_id', v_payee_cash,
      'debit', p_amount,
      'credit', 0,
      'party_id', null,
      'job_id', null,
      'job_cost_category_id', null,
      'cost_classification', '',
      'fixed_asset_id', null,
      'memo', coalesce(p_memo, 'Intercompany settlement')
    ),
    jsonb_build_object(
      'account_id', v_payee_due_from,
      'debit', 0,
      'credit', p_amount,
      'party_id', null,
      'job_id', null,
      'job_cost_category_id', null,
      'cost_classification', '',
      'fixed_asset_id', null,
      'memo', coalesce(p_memo, 'Intercompany settlement')
    )
  );

  v_payer_journal_id := public.teller_post_journal(
    p_organization_id,
    p_payer_legal_entity_id,
    p_settlement_date,
    coalesce(p_memo, 'Intercompany settlement'),
    'intercompany-settlement',
    v_settlement_id,
    null,
    v_payer_lines
  );

  if p_simulate_failure_after = 'after_payer_journal' then
    raise exception 'Simulated failure after payer settlement journal';
  end if;

  v_payee_journal_id := public.teller_post_journal(
    p_organization_id,
    p_payee_legal_entity_id,
    p_settlement_date,
    coalesce(p_memo, 'Intercompany settlement'),
    'intercompany-settlement',
    v_settlement_id,
    null,
    v_payee_lines
  );

  if p_simulate_failure_after = 'after_payee_journal' then
    raise exception 'Simulated failure after payee settlement journal';
  end if;

  update public.teller_intercompany_settlements
  set
    payer_journal_id = v_payer_journal_id,
    payee_journal_id = v_payee_journal_id,
    status = 'posted',
    posted_at = now()
  where id = v_settlement_id;

  return jsonb_build_object(
    'duplicate', false,
    'settlement_id', v_settlement_id,
    'payer_journal_id', v_payer_journal_id,
    'payee_journal_id', v_payee_journal_id
  );
end;
$$;

grant execute on function public.teller_atomic_post_intercompany_settlement(
  uuid, uuid, uuid, date, numeric, text, text, jsonb, uuid, uuid, text, text, jsonb, uuid, text
) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Atomic settlement reversal — paired reversal journals, restores open balance
-- ---------------------------------------------------------------------------

create or replace function public.teller_atomic_reverse_intercompany_settlement(
  p_organization_id uuid,
  p_settlement_id uuid,
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
  v_original public.teller_intercompany_settlements%rowtype;
  v_reversal_id uuid;
  v_payer_reversal uuid;
  v_payee_reversal uuid;
  v_payer_lines jsonb;
  v_payee_lines jsonb;
begin
  if auth.uid() is not null and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to reverse intercompany settlement';
  end if;

  select * into v_original
  from public.teller_intercompany_settlements
  where id = p_settlement_id
    and organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'Intercompany settlement not found';
  end if;

  if v_original.status = 'reversed' then
    return jsonb_build_object(
      'duplicate', true,
      'reversal_settlement_id', v_original.reversal_settlement_id
    );
  end if;

  if v_original.status not in ('posted', 'partially_reconciled', 'reconciled') then
    raise exception 'Only posted settlements can be reversed';
  end if;

  if auth.uid() is not null then
    if not public.teller_can_access_legal_entity(p_organization_id, v_original.payer_legal_entity_id) then
      raise exception 'Not authorized for payer legal entity';
    end if;
    if not public.teller_can_access_legal_entity(p_organization_id, v_original.payee_legal_entity_id) then
      raise exception 'Not authorized for payee legal entity';
    end if;
  end if;

  perform public.teller_acquire_org_accounting_lock(p_organization_id);

  if public.teller_books_closed_through(p_organization_id, v_original.payer_legal_entity_id) is not null
     and p_reversal_date <= public.teller_books_closed_through(
       p_organization_id,
       v_original.payer_legal_entity_id
     ) then
    raise exception 'Payer entity accounting period is closed for reversal date';
  end if;

  if public.teller_books_closed_through(p_organization_id, v_original.payee_legal_entity_id) is not null
     and p_reversal_date <= public.teller_books_closed_through(
       p_organization_id,
       v_original.payee_legal_entity_id
     ) then
    raise exception 'Payee entity accounting period is closed for reversal date';
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
  into v_payer_lines
  from public.teller_journal_lines jl
  where jl.entry_id = v_original.payer_journal_id;

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
  into v_payee_lines
  from public.teller_journal_lines jl
  where jl.entry_id = v_original.payee_journal_id;

  insert into public.teller_intercompany_settlements (
    organization_id,
    payer_legal_entity_id,
    payee_legal_entity_id,
    settlement_date,
    amount,
    status,
    settlement_mode,
    payer_bank_account_id,
    payee_bank_account_id,
    payer_cash_account_id,
    payee_cash_account_id,
    reference,
    memo,
    reverses_settlement_id,
    created_by
  ) values (
    p_organization_id,
    v_original.payer_legal_entity_id,
    v_original.payee_legal_entity_id,
    p_reversal_date,
    v_original.amount,
    'draft',
    v_original.settlement_mode,
    v_original.payer_bank_account_id,
    v_original.payee_bank_account_id,
    v_original.payer_cash_account_id,
    v_original.payee_cash_account_id,
    v_original.reference,
    coalesce(p_memo, 'Settlement reversal'),
    v_original.id,
    coalesce(p_actor_id, auth.uid())
  )
  returning id into v_reversal_id;

  -- Allocations remain on original settlement only; marking it reversed restores open balances.

  if p_simulate_failure_after = 'before_journals' then
    raise exception 'Simulated failure before settlement reversal journals';
  end if;

  v_payer_reversal := public.teller_post_journal(
    p_organization_id,
    v_original.payer_legal_entity_id,
    p_reversal_date,
    coalesce(p_memo, 'Intercompany settlement reversal'),
    'intercompany-settlement-reversal',
    v_reversal_id,
    v_original.payer_journal_id,
    v_payer_lines
  );

  if p_simulate_failure_after = 'after_payer_journal' then
    raise exception 'Simulated failure after payer settlement reversal journal';
  end if;

  v_payee_reversal := public.teller_post_journal(
    p_organization_id,
    v_original.payee_legal_entity_id,
    p_reversal_date,
    coalesce(p_memo, 'Intercompany settlement reversal'),
    'intercompany-settlement-reversal',
    v_reversal_id,
    v_original.payee_journal_id,
    v_payee_lines
  );

  update public.teller_intercompany_settlements
  set
    payer_journal_id = v_payer_reversal,
    payee_journal_id = v_payee_reversal,
    status = 'posted',
    posted_at = now()
  where id = v_reversal_id;

  update public.teller_intercompany_settlements
  set
    status = 'reversed',
    reversal_settlement_id = v_reversal_id,
    reversed_at = now(),
    reversed_by = coalesce(p_actor_id, auth.uid())
  where id = v_original.id;

  return jsonb_build_object(
    'duplicate', false,
    'reversal_settlement_id', v_reversal_id,
    'payer_reversal_journal_id', v_payer_reversal,
    'payee_reversal_journal_id', v_payee_reversal,
    'original_settlement_id', v_original.id
  );
end;
$$;

grant execute on function public.teller_atomic_reverse_intercompany_settlement(
  uuid, uuid, date, text, uuid, text
) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS — org boundary + entity access (reads only; writes via RPCs)
-- ---------------------------------------------------------------------------

alter table public.teller_intercompany_settlements enable row level security;
alter table public.teller_intercompany_settlement_allocations enable row level security;

create policy "teller members read intercompany settlements"
  on public.teller_intercompany_settlements for select
  using (
    public.teller_is_org_member(organization_id)
    and (
      public.teller_can_access_legal_entity(organization_id, payer_legal_entity_id)
      or public.teller_can_access_legal_entity(organization_id, payee_legal_entity_id)
    )
  );

create policy "teller members read intercompany settlement allocations"
  on public.teller_intercompany_settlement_allocations for select
  using (
    public.teller_is_org_member(organization_id)
    and exists (
      select 1
      from public.teller_intercompany_settlements s
      where s.id = settlement_id
        and s.organization_id = organization_id
        and (
          public.teller_can_access_legal_entity(organization_id, s.payer_legal_entity_id)
          or public.teller_can_access_legal_entity(organization_id, s.payee_legal_entity_id)
        )
    )
  );

-- Writes via security definer RPCs only (no direct INSERT/UPDATE policies)
