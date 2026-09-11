-- Phase 15D manual patch — fix teller_guard_tax_transaction_org line check.
-- teller_document_lines has no organization_id; resolve via parent document.
-- Apply manually in Supabase SQL editor. Do not run from Cursor.

create or replace function public.teller_guard_tax_transaction_org()
returns trigger
language plpgsql
as $$
declare
  doc_org uuid;
  line_org uuid;
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
  return new;
end;
$$;
