-- Phase 16C patch: entity-scoped accounting state version RPCs + bump triggers.
-- Required after 042 changed teller_accounting_state_versions PK to (organization_id, legal_entity_id).
-- Operator applies manually — do not auto-run against production.

create or replace function public.teller_get_accounting_state(
  p_org uuid,
  p_legal_entity_id uuid default null
)
returns table (accounting_version bigint, close_state_version bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entity uuid := coalesce(p_legal_entity_id, public.teller_default_legal_entity_id(p_org));
begin
  return query
  select coalesce(v.accounting_version, 0), coalesce(v.close_state_version, 0)
  from public.teller_accounting_state_versions v
  where v.organization_id = p_org
    and v.legal_entity_id = v_entity;
  if not found then
    return query select 0::bigint, 0::bigint;
  end if;
end;
$$;

create or replace function public.teller_increment_accounting_version(
  p_org uuid,
  p_legal_entity_id uuid default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entity uuid := coalesce(p_legal_entity_id, public.teller_default_legal_entity_id(p_org));
  v_version bigint;
begin
  insert into public.teller_accounting_state_versions (
    organization_id,
    legal_entity_id,
    accounting_version,
    close_state_version
  )
  values (p_org, v_entity, 1, 0)
  on conflict (organization_id, legal_entity_id) do update
  set accounting_version = public.teller_accounting_state_versions.accounting_version + 1,
      updated_at = now()
  returning accounting_version into v_version;
  return v_version;
end;
$$;

create or replace function public.teller_increment_close_state_version(
  p_org uuid,
  p_legal_entity_id uuid default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entity uuid := coalesce(p_legal_entity_id, public.teller_default_legal_entity_id(p_org));
  v_version bigint;
begin
  insert into public.teller_accounting_state_versions (
    organization_id,
    legal_entity_id,
    accounting_version,
    close_state_version
  )
  values (p_org, v_entity, 0, 1)
  on conflict (organization_id, legal_entity_id) do update
  set close_state_version = public.teller_accounting_state_versions.close_state_version + 1,
      updated_at = now()
  returning close_state_version into v_version;
  return v_version;
end;
$$;

create or replace function public.teller_journal_entries_bump_accounting_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.teller_increment_accounting_version(NEW.organization_id, NEW.legal_entity_id);
  return NEW;
end;
$$;

create or replace function public.teller_close_state_bump_from_reconciliation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entity uuid;
begin
  if TG_OP = 'UPDATE' and OLD.status is distinct from NEW.status
     and NEW.status in ('completed', 'reopened') then
    select ba.legal_entity_id into v_entity
    from public.teller_bank_accounts ba
    where ba.id = NEW.bank_account_id;
    perform public.teller_increment_close_state_version(NEW.organization_id, v_entity);
  end if;
  return NEW;
end;
$$;

create or replace function public.teller_close_state_bump_from_checklist()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'INSERT'
     or (TG_OP = 'UPDATE' and (OLD.status is distinct from NEW.status or OLD.required is distinct from NEW.required)) then
    perform public.teller_increment_close_state_version(NEW.organization_id, NEW.legal_entity_id);
  end if;
  return NEW;
end;
$$;

grant execute on function public.teller_get_accounting_state(uuid, uuid)
  to authenticated, service_role;
grant execute on function public.teller_increment_accounting_version(uuid, uuid)
  to authenticated, service_role;
grant execute on function public.teller_increment_close_state_version(uuid, uuid)
  to authenticated, service_role;
