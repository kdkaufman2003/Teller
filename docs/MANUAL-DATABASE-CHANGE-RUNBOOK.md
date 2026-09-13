# Manual Database Change Runbook

**MANUAL_DB_CHANGE_RUNBOOK = COMPLETE**

Teller requires **manual** application of SQL patches in Supabase. Cursor and CI never auto-apply.

---

## Pre-flight checklist

- [ ] **WRONG PROJECT** — confirm project ref `ypixbxicdecwfafculha`  
- [ ] **WRONG ENVIRONMENT** — production vs staging vs local  
- [ ] **PATCH ORDER** — verify prior patches applied (probe RPCs)  
- [ ] **IDEMPOTENCY** — patches use `IF NOT EXISTS` / `IF EXISTS` where possible  
- [ ] **READ PATCH** — no destructive data mutation unless explicitly intended  
- [ ] **STATIC VERIFY** — `npm run verify:patch:NNN:static`  

---

## Apply procedure

1. Open Supabase SQL Editor for target project  
2. Paste **entire** patch file contents  
3. Execute  
4. Note date/time in `PHASE-17E-OPERATIONS.md` ledger  
5. Run production verify: `TELLER_CONTROLLED_PROD_TEST=1 npm run verify:phase17e:production`  
6. Run controlled acceptance if applicable  

---

## Post-apply verification

- [ ] Probe RPC returns true  
- [ ] Journal balance unchanged (0 unbalanced)  
- [ ] HFAC baseline unchanged  
- [ ] Application smoke test  

---

## Database patch recovery policy

**DATABASE_PATCH_RECOVERY_POLICY = DOCUMENTED**

**Prefer forward-fix corrective patch.**

| Safe to re-apply / no-op | Unsafe to rollback |
|--------------------------|-------------------|
| Index addition (`IF NOT EXISTS`) | Data transformation |
| Grant/probe function replace | Posted accounting changes |
| RLS policy tighten | Required column with live writes |
| Trigger add (append-only) | Economic history alteration |

**RECENT_PATCH_REAPPLY_RISK = LOW** — patches 051–054 designed idempotent (`IF NOT EXISTS`, `CREATE OR REPLACE`)

If patch partially applied: inspect `pg_indexes`, `pg_trigger`, probe RPC; apply remaining statements; do not blind `DROP` production indexes without evidence.

---

## Configuration recovery

**CONFIGURATION_RECOVERY_RUNBOOK = COMPLETE**

**NON_DATABASE_CONFIG_INVENTORY:**

| Item | Stored in | Recovery |
|------|-----------|----------|
| Vercel env vars | Vercel project settings | Re-enter from secure vault |
| Supabase URL/anon key | Vercel + Supabase dashboard | Copy from dashboard |
| Service role key | Vercel only (never client) | Regenerate if lost |
| HFAC webhook secret | Vercel + HFAC config | Coordinate rotation |
| Auth providers | Supabase Auth settings | Supabase dashboard |
| Domain/DNS | Vercel domains | Vercel dashboard |

Never commit secret values to git.
