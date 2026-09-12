-- Patch 044: fix teller_provision_intercompany_accounts pair lookup (SELECT INTO rowtype bug).
-- Manual apply only after migration 044.

create or replace function public.teller_provision_intercompany_accounts(
  p_organization_id uuid,
  p_owner_entity_id uuid,
  p_counterparty_entity_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_counterparty record;
  v_due_from_id uuid;
  v_due_to_id uuid;
  v_code_from text;
  v_code_to text;
begin
  if p_owner_entity_id = p_counterparty_entity_id then
    raise exception 'Intercompany accounts require distinct entities';
  end if;

  perform public.teller_assert_entity_belongs_to_org(p_organization_id, p_owner_entity_id);
  perform public.teller_assert_entity_belongs_to_org(p_organization_id, p_counterparty_entity_id);

  select due_from_account_id, due_to_account_id
  into v_due_from_id, v_due_to_id
  from public.teller_intercompany_account_pairs
  where owner_legal_entity_id = p_owner_entity_id
    and counterparty_legal_entity_id = p_counterparty_entity_id;

  if found then
    return jsonb_build_object(
      'due_from_account_id', v_due_from_id,
      'due_to_account_id', v_due_to_id,
      'provisioned', false
    );
  end if;

  select entity_code, name into v_counterparty
  from public.teller_legal_entities
  where id = p_counterparty_entity_id
    and organization_id = p_organization_id;

  if not found then
    raise exception 'Counterparty legal entity not found';
  end if;

  v_code_from := 'IC-DF-' || upper(v_counterparty.entity_code);
  v_code_to := 'IC-DT-' || upper(v_counterparty.entity_code);

  select id into v_due_from_id
  from public.teller_accounts
  where legal_entity_id = p_owner_entity_id
    and code = v_code_from;

  if v_due_from_id is null then
    insert into public.teller_accounts (
      organization_id,
      legal_entity_id,
      code,
      name,
      type,
      subtype,
      is_system
    ) values (
      p_organization_id,
      p_owner_entity_id,
      v_code_from,
      'Due From ' || v_counterparty.name,
      'asset',
      'due_from',
      true
    )
    returning id into v_due_from_id;
  end if;

  select id into v_due_to_id
  from public.teller_accounts
  where legal_entity_id = p_owner_entity_id
    and code = v_code_to;

  if v_due_to_id is null then
    insert into public.teller_accounts (
      organization_id,
      legal_entity_id,
      code,
      name,
      type,
      subtype,
      is_system
    ) values (
      p_organization_id,
      p_owner_entity_id,
      v_code_to,
      'Due To ' || v_counterparty.name,
      'liability',
      'due_to',
      true
    )
    returning id into v_due_to_id;
  end if;

  insert into public.teller_intercompany_account_pairs (
    organization_id,
    owner_legal_entity_id,
    counterparty_legal_entity_id,
    due_from_account_id,
    due_to_account_id
  ) values (
    p_organization_id,
    p_owner_entity_id,
    p_counterparty_entity_id,
    v_due_from_id,
    v_due_to_id
  )
  on conflict (owner_legal_entity_id, counterparty_legal_entity_id) do update
    set due_from_account_id = excluded.due_from_account_id,
        due_to_account_id = excluded.due_to_account_id
  returning due_from_account_id, due_to_account_id
  into v_due_from_id, v_due_to_id;

  return jsonb_build_object(
    'due_from_account_id', v_due_from_id,
    'due_to_account_id', v_due_to_id,
    'provisioned', true
  );
end;
$$;
