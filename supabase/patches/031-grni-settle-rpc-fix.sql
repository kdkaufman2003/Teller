-- Hotfix: teller_atomic_settle_inventory_receipt_bill referenced updated_at on
-- teller_purchase_receipt_lines, which has no such column (Phase 6 schema).
-- Re-run this after manual 031 apply if settlement RPC fails with updated_at errors.

create or replace function public.teller_atomic_settle_inventory_receipt_bill(
  p_organization_id uuid,
  p_receipt_line_id uuid,
  p_bill_line_id uuid,
  p_bill_id uuid,
  p_quantity_matched numeric,
  p_receipt_unit_cost numeric,
  p_bill_unit_cost numeric,
  p_idempotency_key text,
  p_entry_date date,
  p_journal_lines jsonb,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_receipt_line public.teller_purchase_receipt_lines%rowtype;
  v_existing public.teller_inventory_receipt_bill_allocations%rowtype;
  v_allocation_id uuid;
  v_journal_id uuid;
  v_receipt_value numeric;
  v_bill_value numeric;
  v_variance numeric;
  v_open_qty numeric;
  v_closed_through date;
begin
  if auth.uid() is not null and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to settle inventory receipt';
  end if;

  perform public.teller_acquire_org_accounting_lock(p_organization_id);

  v_closed_through := public.teller_books_closed_through(p_organization_id);
  if v_closed_through is not null and p_entry_date <= v_closed_through then
    raise exception 'Accounting period is closed through %', v_closed_through;
  end if;

  select * into v_existing
  from public.teller_inventory_receipt_bill_allocations
  where organization_id = p_organization_id and idempotency_key = p_idempotency_key;

  if found then
    return jsonb_build_object(
      'duplicate', true,
      'allocation_id', v_existing.id,
      'journal_entry_id', v_existing.settlement_journal_entry_id
    );
  end if;

  select * into v_receipt_line
  from public.teller_purchase_receipt_lines
  where id = p_receipt_line_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'Receipt line not found'; end if;
  if v_receipt_line.accounting_status <> 'posted' then
    raise exception 'Receipt line must be posted before bill settlement';
  end if;

  v_open_qty := round(v_receipt_line.quantity_received - coalesce(v_receipt_line.quantity_matched, 0), 4);
  if p_quantity_matched - v_open_qty > 0.0001 then
    raise exception 'Match quantity exceeds open receipt quantity';
  end if;

  v_receipt_value := public.teller_inventory_round_money(p_quantity_matched * p_receipt_unit_cost);
  v_bill_value := public.teller_inventory_round_money(p_quantity_matched * p_bill_unit_cost);
  v_variance := public.teller_inventory_round_money(v_bill_value - v_receipt_value);

  v_journal_id := public.teller_post_journal(
    p_organization_id,
    p_entry_date,
    'GRNI bill settlement',
    'inventory_grni_settlement',
    p_bill_id,
    null,
    p_journal_lines
  );

  insert into public.teller_inventory_receipt_bill_allocations (
    organization_id, receipt_line_id, bill_line_id, bill_id,
    quantity_matched, receipt_value_matched, bill_value_matched, variance_amount,
    settlement_journal_entry_id, idempotency_key
  )
  values (
    p_organization_id, p_receipt_line_id, p_bill_line_id, p_bill_id,
    p_quantity_matched, v_receipt_value, v_bill_value, v_variance,
    v_journal_id, p_idempotency_key
  )
  returning id into v_allocation_id;

  update public.teller_purchase_receipt_lines
  set
    quantity_matched = round(coalesce(quantity_matched, 0) + p_quantity_matched, 4),
    value_matched = public.teller_inventory_round_money(coalesce(value_matched, 0) + v_receipt_value)
  where id = p_receipt_line_id;

  return jsonb_build_object(
    'duplicate', false,
    'allocation_id', v_allocation_id,
    'journal_entry_id', v_journal_id,
    'receipt_value_matched', v_receipt_value,
    'bill_value_matched', v_bill_value,
    'variance_amount', v_variance
  );
end;
$$;

grant execute on function public.teller_atomic_settle_inventory_receipt_bill(
  uuid, uuid, uuid, uuid, numeric, numeric, numeric, text, date, jsonb, uuid
) to authenticated, service_role;

notify pgrst, 'reload schema';
