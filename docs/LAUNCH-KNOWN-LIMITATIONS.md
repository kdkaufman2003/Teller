# Teller Launch — Known Limitations

**KNOWN_LIMITATIONS = DOCUMENTED**

These are intentional scope boundaries at Phase 17 launch, not undocumented defects.

## Product scope

- **Not a bank** — Teller does not hold customer funds, store bank passwords, or originate ACH/wire payments.
- **Payroll accounting only** — Teller imports/posts payroll accounting entries; it does not run payroll, calculate withholdings, or file payroll tax returns.
- **Sales tax accounting** — MO/KS reference packs support taxable invoice posting and liability tracking; Teller does not file sales tax returns.
- **Planning vs GL** — Budgets and forecasts in Phase 14 planning are separate from posted GL truth; planning does not create journals.

## Architecture

- **Jobs are org-scoped** — Job costing does not assign a separate `legal_entity_id`; multi-entity context applies to GL documents, not job records.
- **HFAC is optional** — Teller works standalone; HFAC integration is webhook-based and must not be required for non-HFAC customers.
- **Legacy zero-membership entity access** — Documented Phase 16H behavior for users with zero entity memberships is preserved; not redesigned in Phase 17.

## Operations

- **Database forward-fix** — Application rollback does not rollback database state; DB issues require manual patch or corrective migration.
- **Backup/PITR** — Disaster recovery depends on Supabase project backup/PITR settings confirmed in Supabase Dashboard (operator responsibility).
- **No production restore rehearsal** — Documented in 17E; quarterly restore drill recommended post-launch.
- **Scheduler disabled in production** — Recurring/schedule due processing may require manual or external trigger until enabled.

## Performance / UX

- **Dense accountant tables** — Some list views are desktop-first; mobile supports critical flows but not every dense table.
- **SSR list pagination** — Some server-rendered pages may load full org lists; API routes use pagination (17D).

## Test harness

- **Controlled demo fixture debt** — Phase 16 demo org may contain orphan payment rows (17A-014 / 17G-002); isolated from real tenant data.

## Future (not in Phase 17)

- Advanced multicurrency, NCI, goodwill consolidation beyond current eliminations scope
- Payment processing / money movement
- Shared database with HFAC
