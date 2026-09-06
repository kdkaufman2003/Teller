-- Phase 3: Customer Deposits & Unapplied Payments

-- ---------------------------------------------------------------------------
-- Payment allocations: deposit application idempotency + journal linkage
-- ---------------------------------------------------------------------------

alter table public.teller_payment_allocations
  add column if not exists application_journal_entry_id uuid
  references public.teller_journal_entries (id) on delete set null;

alter table public.teller_payment_allocations
  add column if not exists application_event_id uuid;

create index if not exists teller_payment_allocations_app_journal_idx
  on public.teller_payment_allocations (application_journal_entry_id)
  where application_journal_entry_id is not null;

-- One logical deposit application event per organization (retries return same result).
create unique index if not exists teller_payment_allocations_org_event_idx
  on public.teller_payment_allocations (organization_id, application_event_id)
  where application_event_id is not null;

-- Allow multiple deposit_apply rows for the same payment + invoice (partial applies).
drop index if exists public.teller_payment_allocations_payment_doc_kind_idx;

create unique index if not exists teller_payment_allocations_payment_doc_kind_idx
  on public.teller_payment_allocations (payment_id, document_id, allocation_kind)
  where allocation_kind <> 'deposit_apply';

-- ---------------------------------------------------------------------------
-- Journal entries: one application journal per deposit application event
-- ---------------------------------------------------------------------------

create unique index if not exists teller_journal_entries_deposit_application_event_idx
  on public.teller_journal_entries (organization_id, source_id)
  where source_kind = 'deposit-application' and source_id is not null;

-- ---------------------------------------------------------------------------
-- Document journal links: deposit application events
-- ---------------------------------------------------------------------------

alter table public.teller_document_journal_links
  drop constraint if exists teller_document_journal_links_kind_check;

alter table public.teller_document_journal_links
  add constraint teller_document_journal_links_kind_check
  check (link_kind in (
    'accrual',
    'payment',
    'fee',
    'credit',
    'refund',
    'writeoff',
    'reversal',
    'adjustment',
    'deposit_application'
  ));

create index if not exists teller_payments_org_deposit_idx
  on public.teller_payments (organization_id, party_id, payment_type, status, payment_date desc)
  where payment_type = 'customer_deposit';

-- ---------------------------------------------------------------------------
-- Deposit receipt idempotency
-- ---------------------------------------------------------------------------

alter table public.teller_payments
  add column if not exists receipt_event_id uuid;

create unique index if not exists teller_payments_org_receipt_event_idx
  on public.teller_payments (organization_id, receipt_event_id)
  where receipt_event_id is not null;

create unique index if not exists teller_journal_entries_deposit_receipt_event_idx
  on public.teller_journal_entries (organization_id, source_id)
  where source_kind = 'customer-deposit' and source_id is not null;

-- ---------------------------------------------------------------------------
-- Atomic customer deposit receipt (journal + payment)
-- ---------------------------------------------------------------------------

create or replace function public.teller_receive_customer_deposit(
  p_organization_id uuid,
  p_party_id uuid,
  p_amount numeric,
  p_payment_date date,
  p_cash_account_id uuid,
  p_deposits_account_id uuid,
  p_receipt_event_id uuid,
  p_job_id uuid default null,
  p_payment_method text default null,
  p_reference_number text default null,
  p_external_source text default null,
  p_external_id text default null,
  p_memo text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.teller_payments%rowtype;
  v_entry_id uuid;
  v_payment_id uuid;
  v_amount numeric(14, 2);
  v_closed_through date;
  v_journal_memo text;
  v_lines jsonb;
  v_duplicate boolean := false;
  v_recovered boolean := false;
  v_existing_cash uuid;
begin
  v_amount := round(p_amount::numeric, 2);

  if v_amount <= 0 then
    raise exception 'Deposit amount must be greater than zero.';
  end if;

  if p_party_id is null then
    raise exception 'Customer is required for a deposit.';
  end if;

  if auth.uid() is not null
     and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to record deposit';
  end if;

  if not exists (
    select 1
    from public.teller_parties
    where id = p_party_id
      and organization_id = p_organization_id
  ) then
    raise exception 'Customer not found in organization';
  end if;

  if p_job_id is not null and not exists (
    select 1
    from public.teller_jobs
    where id = p_job_id
      and organization_id = p_organization_id
  ) then
    raise exception 'Job not found in organization';
  end if;

  if not exists (
    select 1
    from public.teller_accounts
    where id = p_cash_account_id
      and organization_id = p_organization_id
  ) then
    raise exception 'Cash or bank account is invalid for organization';
  end if;

  if not exists (
    select 1
    from public.teller_accounts
    where id = p_deposits_account_id
      and organization_id = p_organization_id
  ) then
    raise exception 'Customer Deposits account is invalid for organization';
  end if;

  v_closed_through := public.teller_books_closed_through(p_organization_id);
  if v_closed_through is not null and p_payment_date <= v_closed_through then
    raise exception 'Accounting period is closed through %', v_closed_through;
  end if;

  select *
  into v_payment
  from public.teller_payments
  where organization_id = p_organization_id
    and receipt_event_id = p_receipt_event_id
    and payment_type = 'customer_deposit';

  if not found
     and p_external_source is not null
     and p_external_id is not null then
    select *
    into v_payment
    from public.teller_payments
    where organization_id = p_organization_id
      and external_source = p_external_source
      and external_id = p_external_id;
  end if;

  if found then
    if v_payment.party_id is distinct from p_party_id then
      raise exception 'Idempotency conflict: receipt event is tied to a different customer.';
    end if;
    if abs(v_payment.amount - v_amount) > 0.009 then
      raise exception 'Idempotency conflict: receipt event is tied to a different amount.';
    end if;
    if v_payment.payment_date <> p_payment_date then
      raise exception 'Idempotency conflict: receipt event is tied to a different payment date.';
    end if;

    select jl.account_id
    into v_existing_cash
    from public.teller_journal_lines jl
    where jl.entry_id = v_payment.journal_entry_id
      and jl.debit > 0
    limit 1;

    if v_existing_cash is not null and v_existing_cash <> p_cash_account_id then
      raise exception 'Idempotency conflict: receipt event is tied to a different cash account.';
    end if;

    return jsonb_build_object(
      'payment_id', v_payment.id,
      'entry_id', v_payment.journal_entry_id,
      'receipt_event_id', p_receipt_event_id,
      'amount', v_payment.amount,
      'unapplied', v_payment.amount,
      'duplicate', true,
      'recovered', false
    );
  end if;

  select id
  into v_entry_id
  from public.teller_journal_entries
  where organization_id = p_organization_id
    and source_kind = 'customer-deposit'
    and source_id = p_receipt_event_id;

  if v_entry_id is not null then
    v_recovered := true;
  else
    v_journal_memo := case
      when coalesce(trim(p_memo), '') <> '' then
        'Customer deposit · ' || trim(p_memo)
      else
        'Customer deposit received'
    end;

    v_lines := jsonb_build_array(
      jsonb_build_object(
        'account_id', p_cash_account_id,
        'debit', v_amount,
        'credit', 0,
        'party_id', p_party_id,
        'job_id', p_job_id,
        'memo', 'Deposit received'
      ),
      jsonb_build_object(
        'account_id', p_deposits_account_id,
        'debit', 0,
        'credit', v_amount,
        'party_id', p_party_id,
        'job_id', p_job_id,
        'memo', 'Customer deposit liability'
      )
    );

    begin
      v_entry_id := public.teller_post_journal(
        p_organization_id,
        p_payment_date,
        v_journal_memo,
        'customer-deposit',
        p_receipt_event_id,
        null,
        v_lines
      );
    exception
      when unique_violation then
        select id
        into v_entry_id
        from public.teller_journal_entries
        where organization_id = p_organization_id
          and source_kind = 'customer-deposit'
          and source_id = p_receipt_event_id;

        if v_entry_id is null then
          raise;
        end if;

        v_recovered := true;
    end;
  end if;

  begin
    insert into public.teller_payments (
      organization_id,
      document_id,
      party_id,
      job_id,
      amount,
      fee_amount,
      net_amount,
      payment_date,
      payment_method,
      reference_number,
      external_source,
      external_id,
      journal_entry_id,
      payment_type,
      status,
      receipt_event_id,
      metadata
    ) values (
      p_organization_id,
      null,
      p_party_id,
      p_job_id,
      v_amount,
      0,
      null,
      p_payment_date,
      nullif(trim(p_payment_method), ''),
      nullif(trim(p_reference_number), ''),
      nullif(trim(p_external_source), ''),
      nullif(trim(p_external_id), ''),
      v_entry_id,
      'customer_deposit',
      'posted',
      p_receipt_event_id,
      jsonb_build_object('memo', coalesce(p_memo, ''))
    )
    returning id into v_payment_id;
  exception
    when unique_violation then
      select *
      into v_payment
      from public.teller_payments
      where organization_id = p_organization_id
        and (
          receipt_event_id = p_receipt_event_id
          or (
            p_external_source is not null
            and p_external_id is not null
            and external_source = p_external_source
            and external_id = p_external_id
          )
          or journal_entry_id = v_entry_id
        )
      order by created_at
      limit 1;

      if not found then
        raise;
      end if;

      if v_payment.party_id is distinct from p_party_id then
        raise exception 'Idempotency conflict: receipt event is tied to a different customer.';
      end if;
      if abs(v_payment.amount - v_amount) > 0.009 then
        raise exception 'Idempotency conflict: receipt event is tied to a different amount.';
      end if;

      v_duplicate := true;
      v_payment_id := v_payment.id;
      v_entry_id := v_payment.journal_entry_id;
  end;

  return jsonb_build_object(
    'payment_id', v_payment_id,
    'entry_id', v_entry_id,
    'receipt_event_id', p_receipt_event_id,
    'amount', v_amount,
    'unapplied', v_amount,
    'duplicate', v_duplicate,
    'recovered', v_recovered and not v_duplicate
  );
end;
$$;

grant execute on function public.teller_receive_customer_deposit(
  uuid, uuid, numeric, date, uuid, uuid, uuid, uuid, text, text, text, text, text
) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Atomic deposit application (locking + idempotency + journal/allocation/cache)
-- ---------------------------------------------------------------------------

create or replace function public.teller_apply_deposit_to_invoice(
  p_organization_id uuid,
  p_payment_id uuid,
  p_invoice_id uuid,
  p_amount numeric,
  p_application_date date,
  p_application_event_id uuid,
  p_deposits_account_id uuid,
  p_ar_account_id uuid,
  p_memo text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.teller_payments%rowtype;
  v_invoice public.teller_documents%rowtype;
  v_existing_alloc record;
  v_allocation_id uuid;
  v_entry_id uuid;
  v_deposit_applied numeric(14, 2);
  v_deposit_remaining numeric(14, 2);
  v_invoice_paid numeric(14, 2);
  v_invoice_credits numeric(14, 2);
  v_invoice_settled numeric(14, 2);
  v_invoice_remaining numeric(14, 2);
  v_invoice_status text;
  v_closed_through date;
  v_application_memo text;
  v_lines jsonb;
  v_duplicate boolean := false;
  v_recovered boolean := false;
  v_amount numeric(14, 2);
begin
  v_amount := round(p_amount::numeric, 2);

  if v_amount <= 0 then
    raise exception 'Application amount must be greater than zero.';
  end if;

  if auth.uid() is not null
     and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to apply deposit';
  end if;

  select
    pa.id,
    pa.payment_id,
    pa.document_id,
    pa.amount,
    pa.application_journal_entry_id
  into v_existing_alloc
  from public.teller_payment_allocations pa
  where pa.organization_id = p_organization_id
    and pa.application_event_id = p_application_event_id
    and pa.allocation_kind = 'deposit_apply';

  if found then
    if v_existing_alloc.payment_id <> p_payment_id then
      raise exception 'Idempotency conflict: application event is tied to a different deposit.';
    end if;
    if v_existing_alloc.document_id <> p_invoice_id then
      raise exception 'Idempotency conflict: application event is tied to a different invoice.';
    end if;
    if abs(v_existing_alloc.amount - v_amount) > 0.009 then
      raise exception 'Idempotency conflict: application event is tied to a different amount.';
    end if;

    select * into v_payment
    from public.teller_payments
    where id = p_payment_id
      and organization_id = p_organization_id;

    select * into v_invoice
    from public.teller_documents
    where id = p_invoice_id
      and organization_id = p_organization_id;

    select coalesce(sum(pa.amount), 0)
    into v_deposit_applied
    from public.teller_payment_allocations pa
    where pa.organization_id = p_organization_id
      and pa.payment_id = p_payment_id
      and pa.allocation_kind = 'deposit_apply';

    v_deposit_remaining := round(v_payment.amount - v_deposit_applied, 2);

    select coalesce(sum(pa.amount), 0)
    into v_invoice_paid
    from public.teller_payment_allocations pa
    inner join public.teller_payments p on p.id = pa.payment_id
    where pa.organization_id = p_organization_id
      and pa.document_id = p_invoice_id
      and coalesce(p.status, 'posted') = 'posted';

    select coalesce(sum(da.amount), 0)
    into v_invoice_credits
    from public.teller_document_allocations da
    where da.organization_id = p_organization_id
      and da.target_document_id = p_invoice_id;

    v_invoice_settled := round(v_invoice_paid + v_invoice_credits, 2);
    v_invoice_remaining := round(v_invoice.total - v_invoice_settled, 2);

    if v_invoice_remaining <= 0.009 then
      v_invoice_status := 'paid';
    elsif v_invoice_settled > 0.009 then
      v_invoice_status := 'partially_paid';
    else
      v_invoice_status := 'open';
    end if;

    return jsonb_build_object(
      'allocation_id', v_existing_alloc.id,
      'application_entry_id', v_existing_alloc.application_journal_entry_id,
      'application_event_id', p_application_event_id,
      'deposit_remaining', v_deposit_remaining,
      'invoice_remaining', v_invoice_remaining,
      'invoice_status', v_invoice_status,
      'duplicate', true,
      'recovered', false
    );
  end if;

  select *
  into v_payment
  from public.teller_payments
  where id = p_payment_id
    and organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'Deposit payment not found';
  end if;

  select *
  into v_invoice
  from public.teller_documents
  where id = p_invoice_id
    and organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'Invoice not found';
  end if;

  select
    pa.id,
    pa.payment_id,
    pa.document_id,
    pa.amount,
    pa.application_journal_entry_id
  into v_existing_alloc
  from public.teller_payment_allocations pa
  where pa.organization_id = p_organization_id
    and pa.application_event_id = p_application_event_id
    and pa.allocation_kind = 'deposit_apply';

  if found then
    if v_existing_alloc.payment_id <> p_payment_id then
      raise exception 'Idempotency conflict: application event is tied to a different deposit.';
    end if;
    if v_existing_alloc.document_id <> p_invoice_id then
      raise exception 'Idempotency conflict: application event is tied to a different invoice.';
    end if;
    if abs(v_existing_alloc.amount - v_amount) > 0.009 then
      raise exception 'Idempotency conflict: application event is tied to a different amount.';
    end if;

    v_duplicate := true;
    v_allocation_id := v_existing_alloc.id;
    v_entry_id := v_existing_alloc.application_journal_entry_id;
  else
    if v_payment.payment_type <> 'customer_deposit' then
      raise exception 'Only customer deposit payments can be applied with this workflow.';
    end if;

    if coalesce(v_payment.status, 'posted') <> 'posted' then
      raise exception 'Cannot apply a void deposit.';
    end if;

    if v_invoice.kind <> 'invoice' then
      raise exception 'Target must be an invoice.';
    end if;

    if v_invoice.status in ('void', 'draft') then
      raise exception 'Cannot apply deposit to a draft or void invoice.';
    end if;

    if v_payment.party_id is distinct from v_invoice.party_id then
      raise exception 'Deposit can only be applied to invoices for the same customer.';
    end if;

    v_closed_through := public.teller_books_closed_through(p_organization_id);
    if v_closed_through is not null and p_application_date <= v_closed_through then
      raise exception 'Accounting period is closed through %', v_closed_through;
    end if;

    if not exists (
      select 1
      from public.teller_accounts
      where id = p_deposits_account_id
        and organization_id = p_organization_id
    ) then
      raise exception 'Customer Deposits account is invalid for organization';
    end if;

    if not exists (
      select 1
      from public.teller_accounts
      where id = p_ar_account_id
        and organization_id = p_organization_id
    ) then
      raise exception 'AR account is invalid for organization';
    end if;

    select coalesce(sum(pa.amount), 0)
    into v_deposit_applied
    from public.teller_payment_allocations pa
    where pa.organization_id = p_organization_id
      and pa.payment_id = p_payment_id
      and pa.allocation_kind = 'deposit_apply';

    v_deposit_remaining := round(v_payment.amount - v_deposit_applied, 2);

    if v_amount > v_deposit_remaining + 0.009 then
      raise exception 'Application of % exceeds deposit remaining balance of %.', v_amount, v_deposit_remaining;
    end if;

    select coalesce(sum(pa.amount), 0)
    into v_invoice_paid
    from public.teller_payment_allocations pa
    inner join public.teller_payments p on p.id = pa.payment_id
    where pa.organization_id = p_organization_id
      and pa.document_id = p_invoice_id
      and coalesce(p.status, 'posted') = 'posted';

    select coalesce(sum(da.amount), 0)
    into v_invoice_credits
    from public.teller_document_allocations da
    where da.organization_id = p_organization_id
      and da.target_document_id = p_invoice_id;

    v_invoice_settled := round(v_invoice_paid + v_invoice_credits, 2);
    v_invoice_remaining := round(v_invoice.total - v_invoice_settled, 2);

    if v_amount > v_invoice_remaining + 0.009 then
      raise exception 'Payment would exceed invoice remaining balance';
    end if;

    select id
    into v_entry_id
    from public.teller_journal_entries
    where organization_id = p_organization_id
      and source_kind = 'deposit-application'
      and source_id = p_application_event_id;

    if v_entry_id is not null then
      v_recovered := true;
    else
      v_application_memo := case
        when coalesce(trim(p_memo), '') <> '' then
          'Apply deposit to ' || v_invoice.number || ' · ' || trim(p_memo)
        else
          'Apply deposit to ' || v_invoice.number
      end;

      v_lines := jsonb_build_array(
        jsonb_build_object(
          'account_id', p_deposits_account_id,
          'debit', v_amount,
          'credit', 0,
          'party_id', v_invoice.party_id,
          'job_id', v_invoice.job_id,
          'memo', 'Release customer deposit liability'
        ),
        jsonb_build_object(
          'account_id', p_ar_account_id,
          'debit', 0,
          'credit', v_amount,
          'party_id', v_invoice.party_id,
          'job_id', v_invoice.job_id,
          'memo', 'Apply deposit to ' || v_invoice.number
        )
      );

      begin
        v_entry_id := public.teller_post_journal(
          p_organization_id,
          p_application_date,
          v_application_memo,
          'deposit-application',
          p_application_event_id,
          null,
          v_lines
        );
      exception
        when unique_violation then
          select id
          into v_entry_id
          from public.teller_journal_entries
          where organization_id = p_organization_id
            and source_kind = 'deposit-application'
            and source_id = p_application_event_id;

          if v_entry_id is null then
            raise;
          end if;

          v_recovered := true;
      end;
    end if;

    begin
      insert into public.teller_payment_allocations (
        organization_id,
        payment_id,
        document_id,
        amount,
        allocation_kind,
        application_journal_entry_id,
        application_event_id
      ) values (
        p_organization_id,
        p_payment_id,
        p_invoice_id,
        v_amount,
        'deposit_apply',
        v_entry_id,
        p_application_event_id
      )
      returning id into v_allocation_id;
    exception
      when unique_violation then
        select
          pa.id,
          pa.payment_id,
          pa.document_id,
          pa.amount,
          pa.application_journal_entry_id
        into v_existing_alloc
        from public.teller_payment_allocations pa
        where pa.organization_id = p_organization_id
          and pa.application_event_id = p_application_event_id
          and pa.allocation_kind = 'deposit_apply';

        if not found then
          raise;
        end if;

        if v_existing_alloc.payment_id <> p_payment_id then
          raise exception 'Idempotency conflict: application event is tied to a different deposit.';
        end if;
        if v_existing_alloc.document_id <> p_invoice_id then
          raise exception 'Idempotency conflict: application event is tied to a different invoice.';
        end if;
        if abs(v_existing_alloc.amount - v_amount) > 0.009 then
          raise exception 'Idempotency conflict: application event is tied to a different amount.';
        end if;

        v_duplicate := true;
        v_allocation_id := v_existing_alloc.id;
        v_entry_id := v_existing_alloc.application_journal_entry_id;
    end;

    if not v_duplicate then
      insert into public.teller_document_journal_links (
        organization_id,
        document_id,
        journal_entry_id,
        link_kind,
        payment_id
      )
      select
        p_organization_id,
        p_invoice_id,
        v_entry_id,
        'deposit_application',
        p_payment_id
      where not exists (
        select 1
        from public.teller_document_journal_links
        where organization_id = p_organization_id
          and document_id = p_invoice_id
          and journal_entry_id = v_entry_id
          and link_kind = 'deposit_application'
      );
    end if;
  end if;

  select coalesce(sum(pa.amount), 0)
  into v_invoice_paid
  from public.teller_payment_allocations pa
  inner join public.teller_payments p on p.id = pa.payment_id
  where pa.organization_id = p_organization_id
    and pa.document_id = p_invoice_id
    and coalesce(p.status, 'posted') = 'posted';

  select coalesce(sum(da.amount), 0)
  into v_invoice_credits
  from public.teller_document_allocations da
  where da.organization_id = p_organization_id
    and da.target_document_id = p_invoice_id;

  v_invoice_settled := round(v_invoice_paid + v_invoice_credits, 2);
  v_invoice_remaining := round(v_invoice.total - v_invoice_settled, 2);

  if v_invoice_remaining <= 0.009 then
    v_invoice_status := 'paid';
  elsif v_invoice_settled > 0.009 then
    v_invoice_status := 'partially_paid';
  else
    v_invoice_status := 'open';
  end if;

  update public.teller_documents
  set
    status = v_invoice_status,
    amount_paid = round(v_invoice_paid, 2),
    updated_at = now()
  where id = p_invoice_id;

  select coalesce(sum(pa.amount), 0)
  into v_deposit_applied
  from public.teller_payment_allocations pa
  where pa.organization_id = p_organization_id
    and pa.payment_id = p_payment_id
    and pa.allocation_kind = 'deposit_apply';

  v_deposit_remaining := round(v_payment.amount - v_deposit_applied, 2);

  return jsonb_build_object(
    'allocation_id', v_allocation_id,
    'application_entry_id', v_entry_id,
    'application_event_id', p_application_event_id,
    'deposit_remaining', v_deposit_remaining,
    'invoice_remaining', v_invoice_remaining,
    'invoice_status', v_invoice_status,
    'duplicate', v_duplicate,
    'recovered', v_recovered
  );
end;
$$;

grant execute on function public.teller_apply_deposit_to_invoice(
  uuid, uuid, uuid, numeric, date, uuid, uuid, uuid, text
) to authenticated, service_role;
