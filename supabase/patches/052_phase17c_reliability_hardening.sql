-- Phase 17C: idempotency lifecycle + allocation capacity guards.
-- Manual application only. No data rewrite.

-- ---------------------------------------------------------------------------
-- HFAC webhook processing lifecycle (fix record-before-process retry gap)
-- ---------------------------------------------------------------------------

alter table public.teller_hfac_webhook_events
  add column if not exists processing_status text;

update public.teller_hfac_webhook_events
set processing_status = 'processed'
where processing_status is null;

alter table public.teller_hfac_webhook_events
  alter column processing_status set default 'pending';

alter table public.teller_hfac_webhook_events
  alter column processing_status set not null;

alter table public.teller_hfac_webhook_events
  drop constraint if exists teller_hfac_webhook_events_processing_status_check;

alter table public.teller_hfac_webhook_events
  add constraint teller_hfac_webhook_events_processing_status_check
  check (processing_status in ('pending', 'processed', 'failed'));

alter table public.teller_hfac_webhook_events
  add column if not exists processed_at timestamptz,
  add column if not exists last_error text;

update public.teller_hfac_webhook_events
set processed_at = received_at
where processing_status = 'processed' and processed_at is null;

-- ---------------------------------------------------------------------------
-- Core payment idempotency key (API / client retry)
-- ---------------------------------------------------------------------------

alter table public.teller_payments
  add column if not exists idempotency_key text;

create unique index if not exists teller_payments_org_idempotency_key_uidx
  on public.teller_payments (organization_id, idempotency_key)
  where idempotency_key is not null;

-- ---------------------------------------------------------------------------
-- Payment allocation capacity (defense in depth — deposit_apply uses RPC guards)
-- ---------------------------------------------------------------------------

create or replace function public.teller_payment_allocation_capacity_check()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_doc_total numeric(14, 2);
  v_doc_settled numeric(14, 2);
  v_payment_amount numeric(14, 2);
  v_payment_allocated numeric(14, 2);
begin
  if new.allocation_kind = 'deposit_apply' then
    return new;
  end if;

  if new.document_id is not null then
    select d.total
      into v_doc_total
    from public.teller_documents d
    where d.id = new.document_id
      and d.organization_id = new.organization_id;

    if v_doc_total is null then
      raise exception 'Document not found for payment allocation';
    end if;

    v_doc_settled := public.teller_active_payment_allocation_total(
      new.organization_id,
      new.document_id,
      null
    );

    if v_doc_settled + new.amount > v_doc_total + 0.009 then
      raise exception 'Payment allocation exceeds document capacity';
    end if;
  end if;

  if new.payment_id is not null then
    select p.amount
      into v_payment_amount
    from public.teller_payments p
    where p.id = new.payment_id
      and p.organization_id = new.organization_id;

    if v_payment_amount is null then
      raise exception 'Payment not found for allocation';
    end if;

    v_payment_allocated := public.teller_active_payment_allocation_total(
      new.organization_id,
      null,
      new.payment_id
    );

    if v_payment_allocated + new.amount > v_payment_amount + 0.009 then
      raise exception 'Payment allocation exceeds payment amount';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists teller_payment_allocation_capacity_trg
  on public.teller_payment_allocations;

create trigger teller_payment_allocation_capacity_trg
  before insert
  on public.teller_payment_allocations
  for each row
  execute function public.teller_payment_allocation_capacity_check();

-- ---------------------------------------------------------------------------
-- Document credit allocation capacity
-- ---------------------------------------------------------------------------

create or replace function public.teller_document_allocation_capacity_check()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source_total numeric(14, 2);
  v_source_applied numeric(14, 2);
  v_target_total numeric(14, 2);
  v_target_settled numeric(14, 2);
begin
  if new.allocation_kind not in ('customer_credit_apply', 'vendor_credit_apply') then
    return new;
  end if;

  select d.total into v_source_total
  from public.teller_documents d
  where d.id = new.source_document_id
    and d.organization_id = new.organization_id;

  if v_source_total is null then
    raise exception 'Source document not found for credit allocation';
  end if;

  v_source_applied := public.teller_active_document_allocation_total(
    new.organization_id,
    null,
    new.source_document_id
  );

  if v_source_applied + new.amount > v_source_total + 0.009 then
    raise exception 'Credit allocation exceeds source document capacity';
  end if;

  select d.total into v_target_total
  from public.teller_documents d
  where d.id = new.target_document_id
    and d.organization_id = new.organization_id;

  if v_target_total is null then
    raise exception 'Target document not found for credit allocation';
  end if;

  v_target_settled :=
    public.teller_active_payment_allocation_total(new.organization_id, new.target_document_id, null)
    + public.teller_active_document_allocation_total(new.organization_id, new.target_document_id, null)
    + public.teller_document_writeoff_total(new.organization_id, new.target_document_id);

  if v_target_settled + new.amount > v_target_total + 0.009 then
    raise exception 'Credit allocation exceeds target document remaining capacity';
  end if;

  return new;
end;
$$;

drop trigger if exists teller_document_allocation_capacity_trg
  on public.teller_document_allocations;

create trigger teller_document_allocation_capacity_trg
  before insert
  on public.teller_document_allocations
  for each row
  execute function public.teller_document_allocation_capacity_check();

-- ---------------------------------------------------------------------------
-- Probe
-- ---------------------------------------------------------------------------

create or replace function public.teller_phase17c_reliability_probe()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hfac_status_col boolean;
  v_payment_idempotency_col boolean;
  v_payment_cap_trg boolean;
  v_doc_cap_trg boolean;
begin
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'teller_hfac_webhook_events'
      and column_name = 'processing_status'
  ) into v_hfac_status_col;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'teller_payments'
      and column_name = 'idempotency_key'
  ) into v_payment_idempotency_col;

  select exists (
    select 1 from pg_trigger
    where tgname = 'teller_payment_allocation_capacity_trg'
  ) into v_payment_cap_trg;

  select exists (
    select 1 from pg_trigger
    where tgname = 'teller_document_allocation_capacity_trg'
  ) into v_doc_cap_trg;

  return v_hfac_status_col
    and v_payment_idempotency_col
    and v_payment_cap_trg
    and v_doc_cap_trg;
end;
$$;

grant execute on function public.teller_phase17c_reliability_probe() to authenticated, service_role;
