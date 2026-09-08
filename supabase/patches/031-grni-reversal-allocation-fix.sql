-- Hotfix: reversal allocation used negative quantity_matched which violates qty_positive check.
-- Reversal rows use positive quantities with reversal_of_allocation_id linkage.

create or replace function public.teller_atomic_reverse_inventory_receipt_bill_allocation(
  p_organization_id uuid,
  p_allocation_id uuid,
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
  v_original public.teller_inventory_receipt_bill_allocations%rowtype;
  v_existing public.teller_inventory_receipt_bill_allocations%rowtype;
  v_reversal_id uuid;
  v_journal_id uuid;
  v_closed_through date;
begin
  if auth.uid() is not null and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to reverse GRNI settlement';
  end if;

  perform public.teller_acquire_org_accounting_lock(p_organization_id);

  select * into v_existing
  from public.teller_inventory_receipt_bill_allocations
  where organization_id = p_organization_id and idempotency_key = p_idempotency_key;

  if found then
    return jsonb_build_object('duplicate', true, 'allocation_id', v_existing.id);
  end if;

  select * into v_original
  from public.teller_inventory_receipt_bill_allocations
  where id = p_allocation_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'Allocation not found'; end if;
  if v_original.reversed_by_allocation_id is not null then
    raise exception 'Allocation already reversed';
  end if;

  v_closed_through := public.teller_books_closed_through(p_organization_id);
  if v_closed_through is not null and p_entry_date <= v_closed_through then
    raise exception 'Accounting period is closed through %', v_closed_through;
  end if;

  v_journal_id := public.teller_post_journal(
    p_organization_id,
    p_entry_date,
    'GRNI settlement reversal',
    'inventory_grni_settlement',
    p_allocation_id,
    null,
    p_journal_lines
  );

  insert into public.teller_inventory_receipt_bill_allocations (
    organization_id, receipt_line_id, bill_line_id, bill_id,
    quantity_matched, receipt_value_matched, bill_value_matched, variance_amount,
    settlement_journal_entry_id, reversal_of_allocation_id, idempotency_key
  )
  values (
    p_organization_id, v_original.receipt_line_id, v_original.bill_line_id, v_original.bill_id,
    v_original.quantity_matched, v_original.receipt_value_matched, v_original.bill_value_matched,
    v_original.variance_amount, v_journal_id, p_allocation_id, p_idempotency_key
  )
  returning id into v_reversal_id;

  update public.teller_inventory_receipt_bill_allocations
  set reversed_by_allocation_id = v_reversal_id
  where id = p_allocation_id;

  update public.teller_purchase_receipt_lines
  set
    quantity_matched = round(greatest(0, quantity_matched - v_original.quantity_matched), 4),
    value_matched = public.teller_inventory_round_money(greatest(0, value_matched - v_original.receipt_value_matched))
  where id = v_original.receipt_line_id;

  return jsonb_build_object(
    'duplicate', false,
    'reversal_allocation_id', v_reversal_id,
    'journal_entry_id', v_journal_id
  );
end;
$$;

grant execute on function public.teller_atomic_reverse_inventory_receipt_bill_allocation(
  uuid, uuid, text, date, jsonb, uuid
) to authenticated, service_role;

notify pgrst, 'reload schema';
