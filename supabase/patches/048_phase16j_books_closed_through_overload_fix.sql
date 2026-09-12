-- Phase 16J corrective patch (manual apply only)
--
-- Migration 042 added entity-scoped teller_books_closed_through(p_org, p_legal_entity_id)
-- but did not drop the legacy single-argument overload from migration 025.
-- PostgreSQL then treats one-argument calls as ambiguous ("function is not unique"),
-- breaking legacy RPCs (banking categorize/match, payroll, inventory, etc.).
--
-- Safe: the two-argument form defaults p_legal_entity_id to the org default entity,
-- preserving single-entity backward compatibility.

drop function if exists public.teller_books_closed_through(uuid);

-- Reassert the canonical entity-scoped definition (idempotent).
create or replace function public.teller_books_closed_through(
  p_org uuid,
  p_legal_entity_id uuid default null
)
returns date
language sql
stable
security definer
set search_path = public
as $$
  select pc.effective_closed_through
  from public.teller_period_closes pc
  where pc.organization_id = p_org
    and pc.legal_entity_id = coalesce(
      p_legal_entity_id,
      public.teller_default_legal_entity_id(p_org)
    )
  order by pc.closed_at desc, pc.id desc
  limit 1;
$$;

grant execute on function public.teller_books_closed_through(uuid, uuid) to authenticated, service_role;

-- Production probe: returns true when only the canonical overload remains callable.
create or replace function public.teller_phase16j_books_closed_probe(p_org uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_default uuid;
  v_closed date;
begin
  v_default := public.teller_default_legal_entity_id(p_org);
  if v_default is null then
    return false;
  end if;

  -- One-argument call must resolve without ambiguity after patch 048.
  v_closed := public.teller_books_closed_through(p_org);
  perform public.teller_books_closed_through(p_org, v_default);
  return true;
exception
  when others then
    return false;
end;
$$;

grant execute on function public.teller_phase16j_books_closed_probe(uuid) to authenticated, service_role;
