# Teller test workflow

Four-tier testing for faster iteration without weakening accounting gates.

## Commands

```bash
# Level 1 — daily loop (~60s target, no DB)
npm run test:fast

# Level 2 — current phase (unit + verify + logic matrix)
npm run test:phase          # TELLER_TEST_PHASE defaults to 13
npm run test:phase13          # explicit Phase 13

# Level 3 — current phase + dependency regressions
npm run test:affected

# Level 4 — full historical release gate (unit + build + all demos)
npm run test:full

# Pre-production deploy verification
npm run verify:deploy
TELLER_INCLUDE_DB_ACCEPTANCE=1 npm run verify:deploy   # include DB acceptance at gate
```

## When to use each tier

| Situation | Command |
|-----------|---------|
| Editing Phase 13 library code | `test:fast` |
| Before pushing Phase 13 changes | `test:phase` or `test:affected` |
| Touching `post.ts`, shared RPCs, RLS | `test:affected` minimum |
| Pre-production deploy | `verify:deploy` |
| Major release / phase completion | `test:full` + `accept:phaseN:controlled` |

## Phase 13 status

Phase 13 is **complete** and deployed. See `docs/PHASE-13-COMPLETION.md`.

- DB acceptance: **70/70 PASS** — do not rerun unless economic/RPC behavior changes
- Production: `https://teller-indol.vercel.app` (`f81f433`)

## Database rule

**All migrations and SQL patches are manually applied.** Test scripts never apply schema changes.

Dependency details: `docs/TEST-DEPENDENCY-MAP.md`
