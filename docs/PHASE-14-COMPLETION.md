# Phase 14 — Budgeting, forecasting & cash planning (production complete)

**Completed:** 2026-09-09  
**Migration:** `032_phase14_planning.sql` (manually applied)  
**SQL patches (manual):** `032-phase14d-forecast-lines.sql`, `033-phase14f-cash-forecast.sql`, `034-phase14h-scenarios.sql`  
**Production deploy:** `https://teller-indol.vercel.app`  
**Git commit (application):** `ca0ac38dacb8c45ed31c6a290d4276fb13b7f3d9`  
**Deployment ID:** `dpl_7RH5vHiGNFVv6tU1nhZ79oJEcn44`

> **Permanent rule:** ALL Teller Supabase migrations and SQL patches are manually applied by the operator. Source control presence does not authorize automatic execution.

## Gates

| Gate | Result |
|------|--------|
| Migration 032 + patches verified (REST probes) | PASS |
| `teller_post_journal` unchanged | PASS |
| Local fast tests | **207/207** |
| Phase 14 unit tests | PASS |
| Controlled DB acceptance | **106/106** |
| Full release gate (14K) | **689/689** + build + demos |
| Pre-deploy HFAC baseline | 8 docs, 3 payments, 16 journals, 0 HFAC planning |
| Production deploy Ready | PASS |
| Production alias updated | PASS |
| Production smoke test | PASS — `/login` 200; planning/reports routes 307 (auth); planning APIs 401 |
| Post-deploy HFAC unchanged | PASS |
| Production journals balanced | PASS |
| Pre/post accounting differences | **0** |
| Planning deploy accounting writes | **0** |

**Snapshots**

- Pre-deploy: `artifacts/controlled-prod-snapshots/pre-phase14-deploy-2026-09-09T16-25-36-386Z.json`
- Post-deploy: `artifacts/controlled-prod-snapshots/post-phase14-deploy-2026-09-09T19-34-36-183Z.json`

## Slices delivered (14A–14L)

| Slice | Capability |
|-------|------------|
| 14A | Planning settings, budgets, audit |
| 14B | Budget CRUD, approval/lock lifecycle |
| 14C | Budget vs Actual reporting |
| 14D | Rolling forecasts |
| 14E | Assumption-driven forecast refresh |
| 14F | 13-week cash outlook |
| 14G | Cash source adapters + overrides |
| 14H | Scenario modeling |
| 14I | Owner planning dashboard |
| 14J | Accountant planning package + close integration |
| 14K | Final acceptance gate |
| 14L | Production deploy + post-deploy verification |

## Accounting boundary

Planning modules aggregate GL and subledger facts for forward-looking views. They do **not** post journals, mutate close state, or alter HFAC integration economics.

## Next

**Phase 15** — not started. See [PHASE-14-PLAN.md](./PHASE-14-PLAN.md) backlog.
