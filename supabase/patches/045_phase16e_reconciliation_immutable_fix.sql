-- Patch 045: fix pair reconciliation last_activity query + protect reversed settlements.
-- Manual apply only (after migration 045).

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
