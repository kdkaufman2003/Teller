-- Phase 16J corrective patch (manual apply only)
-- Legacy deposit/payment RPCs may omit legal_entity_id on teller_payments inserts.

drop trigger if exists teller_payments_default_legal_entity on public.teller_payments;
create trigger teller_payments_default_legal_entity
  before insert on public.teller_payments
  for each row execute function public.teller_default_insert_legal_entity();
