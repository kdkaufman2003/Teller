# Phase 15 — Sales & Use Tax (production complete)

**Completed:** 2026-09-11  
**Migrations (manual):** `035_phase15_tax_accounting.sql`, `037_phase15f_tax_filing_periods.sql`, `038_phase15g_tax_authority_payments.sql`  
**SQL patches (manual):** `036_phase15d_tax_line_org_guard.sql`, `039_phase15g_tax_transaction_org_guard_fix.sql`  
**Production deploy:** `https://teller-indol.vercel.app`  
**Git commit (application):** `71942a41e743e706273e316274946b8921b80b60`  
**Deployment ID:** `HhrjMrgJBizfyMjzcMTRfsddCrmy`

> **Permanent rule:** ALL Teller Supabase migrations and SQL patches are manually applied by the operator. Source control presence does not authorize automatic execution.

## Gates

| Gate | Result |
|------|--------|
| Release candidate commit | PASS — `71942a4` |
| Static tax verify | PASS — `npm run verify:phase15:tax` |
| Production schema probes (035/037/038) | PASS |
| Controlled DB acceptance | **111/111** |
| Full release gate (15K) | PASS |
| Pre-deploy HFAC baseline | 8 docs, 17 journals, 0 HFAC tax rows |
| Production deploy Ready | PASS — Vercel GitHub status success |
| Production alias updated | PASS — `https://teller-indol.vercel.app` |
| Production smoke test | PASS — tax UI routes 307; tax APIs 401/405 |
| Post-deploy HFAC unchanged | PASS |
| Production journals balanced | PASS (1487 entries, 0 unbalanced) |
| MO/KS reference data loaded | PASS — MO-2026.1 + KS-2026.1 |
| Tax deploy accounting writes | 0 on HFAC |
| Migrations/SQL auto-applied | **false** |

## Rollback criteria

Revert the **application deploy** (Vercel → prior SHA) if any post-deploy gate fails:

1. Deployed SHA ≠ `71942a41e743e706273e316274946b8921b80b60`
2. HFAC accounting counts change
3. Global unbalanced journal count > 0
4. Production tax smoke fails
5. Post-deploy schema probes fail

Database rollback is forward-only — use Supabase PITR or corrective SQL under operator control only.

## Slices delivered (15A–15L)

| Slice | Capability |
|-------|------------|
| 15A | Tax schema, settings, subledger foundation |
| 15B | Tax calculation engine + snapshots |
| 15C | Exemption certificates |
| 15D | Sales tax posting (invoices/credits) |
| 15E | Purchase / use tax |
| 15F | Filing periods + reconciliation |
| 15G | Tax authority payments + adjustments |
| 15H | MO/KS state configuration packs |
| 15I | Tax reports + accountant package |
| 15J | Owner tax dashboard |
| 15K | Final acceptance + release candidate |
| 15L | Production deploy + post-deploy verification |

## Snapshots

- Pre-deploy: `artifacts/controlled-prod-snapshots/pre-phase15-deploy-2026-09-11T23-32-23-590Z.json`
- Post-deploy: `artifacts/controlled-prod-snapshots/post-phase15-deploy-2026-09-11T23-36-36-950Z.json`
- Pre/post HFAC accounting differences: **0**

## Operator commands (15L)

```bash
npm run snapshot:phase15:production
# push release commit → Vercel auto-deploy
npm run snapshot:phase15:production:post
npm run verify:phase15:production-smoke
npm run tax-rules:load-state-packs
node scripts/compare-phase15-snapshots.mjs <pre.json> <post.json>
```

See [PHASE-15-IMPLEMENTATION.md](./PHASE-15-IMPLEMENTATION.md) and [PHASE-15-RELEASE-NOTES.md](./PHASE-15-RELEASE-NOTES.md).
