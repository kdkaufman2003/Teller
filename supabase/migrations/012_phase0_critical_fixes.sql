-- Phase 0: partially_paid document status for AP lifecycle

alter table public.teller_documents
  drop constraint if exists teller_documents_status_check;

alter table public.teller_documents
  add constraint teller_documents_status_check
  check (status in ('draft', 'open', 'partially_paid', 'paid', 'void'));
