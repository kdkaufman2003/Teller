-- Phase 15G manual patch — restore patch 036 line org guard inside 15G-extended trigger.
-- Migration 038 replaced teller_guard_tax_transaction_org and regressed the line_id check
-- (teller_document_lines has no organization_id). Apply manually in Supabase SQL editor.

create or replace function public.teller_guard_tax_transaction_org()
returns trigger
language plpgsql
as $$
declare
  doc_org uuid;
  line_org uuid;
  reg_org uuid;
  period_org uuid;
begin
  if new.document_id is not null then
    select organization_id into doc_org from public.teller_documents where id = new.document_id;
    if doc_org is distinct from new.organization_id then
      raise exception 'Tax transaction document must belong to organization';
    end if;
  end if;
  if new.line_id is not null then
    select d.organization_id into line_org
    from public.teller_document_lines l
    join public.teller_documents d on d.id = l.document_id
    where l.id = new.line_id;
    if line_org is distinct from new.organization_id then
      raise exception 'Tax transaction line must belong to organization';
    end if;
  end if;
  if new.posted_journal_entry_id is not null then
    select organization_id into doc_org from public.teller_journal_entries where id = new.posted_journal_entry_id;
    if doc_org is distinct from new.organization_id then
      raise exception 'Tax transaction journal must belong to organization';
    end if;
  end if;
  if new.registration_id is not null then
    select organization_id into reg_org from public.teller_tax_registrations where id = new.registration_id;
    if reg_org is distinct from new.organization_id then
      raise exception 'Tax transaction registration must belong to organization';
    end if;
  end if;
  if new.filing_period_id is not null then
    select organization_id into period_org from public.teller_tax_filing_periods where id = new.filing_period_id;
    if period_org is distinct from new.organization_id then
      raise exception 'Tax transaction filing period must belong to organization';
    end if;
  end if;
  if new.authority_payment_id is not null then
    select organization_id into reg_org from public.teller_tax_authority_payments where id = new.authority_payment_id;
    if reg_org is distinct from new.organization_id then
      raise exception 'Tax transaction authority payment must belong to organization';
    end if;
  end if;
  return new;
end;
$$;
