-- Phase 16J corrective patch (manual apply only)
--
-- After migration 042, entity-scoped teller_post_journal(uuid, uuid, ...) is canonical.
-- Legacy 7-argument overloads (Phase 5–13 RPCs) still insert journals without legal_entity_id.
-- Legacy RPC document/checklist inserts omit legal_entity_id as well.
--
-- This patch:
-- 1. Replaces the 7-arg teller_post_journal wrapper to delegate to the 8-arg canonical RPC.
-- 2. Defaults legal_entity_id on legacy INSERT paths that predate entity columns.

-- ---------------------------------------------------------------------------
-- Canonical legacy post_journal wrapper (single-entity default entity)
-- ---------------------------------------------------------------------------

drop function if exists public.teller_post_journal(uuid, date, text, text, uuid, uuid, jsonb);

create or replace function public.teller_post_journal(
  p_organization_id uuid,
  p_entry_date date,
  p_memo text,
  p_source_kind text,
  p_source_id uuid,
  p_reverses_entry_id uuid,
  p_lines jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entity_id uuid;
begin
  v_entity_id := public.teller_default_legal_entity_id(p_organization_id);
  if v_entity_id is null then
    raise exception 'Default legal entity missing for organization %', p_organization_id;
  end if;

  return public.teller_post_journal(
    p_organization_id,
    v_entity_id,
    p_entry_date,
    p_memo,
    p_source_kind,
    p_source_id,
    p_reverses_entry_id,
    p_lines
  );
end;
$$;

grant execute on function public.teller_post_journal(uuid, date, text, text, uuid, uuid, jsonb)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Legacy row defaults (org default entity — single-entity backward compatibility)
-- ---------------------------------------------------------------------------

create or replace function public.teller_default_insert_legal_entity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.legal_entity_id is null then
    NEW.legal_entity_id := public.teller_default_legal_entity_id(NEW.organization_id);
    if NEW.legal_entity_id is null then
      raise exception 'legal_entity_id is required';
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists teller_documents_default_legal_entity on public.teller_documents;
create trigger teller_documents_default_legal_entity
  before insert on public.teller_documents
  for each row execute function public.teller_default_insert_legal_entity();

drop trigger if exists teller_adjusting_journal_default_legal_entity
  on public.teller_adjusting_journal_entries;
create trigger teller_adjusting_journal_default_legal_entity
  before insert on public.teller_adjusting_journal_entries
  for each row execute function public.teller_default_insert_legal_entity();

drop trigger if exists teller_close_checklist_default_legal_entity
  on public.teller_close_checklist_items;
create trigger teller_close_checklist_default_legal_entity
  before insert on public.teller_close_checklist_items
  for each row execute function public.teller_default_insert_legal_entity();

-- ---------------------------------------------------------------------------
-- Production probe
-- ---------------------------------------------------------------------------

create or replace function public.teller_phase16j_legacy_posting_probe(p_org uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_overload_count int;
begin
  select count(*) into v_overload_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'teller_post_journal';

  if v_overload_count <> 2 then
    return false;
  end if;

  perform public.teller_default_legal_entity_id(p_org);
  return exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    where c.relname = 'teller_documents'
      and t.tgname = 'teller_documents_default_legal_entity'
      and not t.tgisinternal
  );
end;
$$;

grant execute on function public.teller_phase16j_legacy_posting_probe(uuid) to authenticated, service_role;
