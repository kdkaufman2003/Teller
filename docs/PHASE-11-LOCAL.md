# Phase 11 — Subledger automation

**Status:** Production complete — see [PHASE-11-COMPLETION.md](./PHASE-11-COMPLETION.md).

Migration `027_phase11_subledger_automation.sql` was manually applied. Application deployed to `https://teller-indol.vercel.app` (`dpl_8ueLU88MWAW2nJbLzqd8YAcUQ7tC`).

## Scripts

```bash
npm run setup:phase11-demo-org
npm run verify:phase11:controlled
npm run verify:migration:027:controlled
npm run demo:phase11:controlled     # 105/105 logic matrix
npm run accept:phase11:controlled   # 19/19 DB acceptance (Phase 11 demo org only)
npm run audit:phase11:deployment-compat
```

## Deferred

- Production scheduler/cron (not enabled)
- Accrual-to-bill settlement (Phase 11.1)
