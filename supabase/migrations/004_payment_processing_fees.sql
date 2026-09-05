-- Payment processing fee account for existing organizations

insert into public.teller_accounts (
  organization_id,
  code,
  name,
  type,
  subtype,
  industry_tag,
  archived
)
select
  org.id,
  '6150',
  'Payment Processing Fees',
  'expense',
  'payment_fee',
  '',
  false
from public.teller_organizations org
where not exists (
  select 1
  from public.teller_accounts account
  where account.organization_id = org.id
    and (
      account.subtype = 'payment_fee'
      or account.code = '6150'
      or account.name ilike '%payment processing%'
    )
);

-- Tag SaaS payment processing COGS accounts when present
update public.teller_accounts
set subtype = 'payment_fee'
where subtype is distinct from 'payment_fee'
  and code = '5100'
  and name ilike '%payment processing%';
