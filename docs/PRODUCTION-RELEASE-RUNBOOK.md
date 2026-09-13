# Teller Production Release Runbook

**PRODUCTION_RELEASE_RUNBOOK = COMPLETE**

Production URL: https://teller-indol.vercel.app  
Supabase project: `ypixbxicdecwfafculha`

---

## Pre-deploy

- [ ] All changes committed; branch reviewed  
- [ ] `npm run test:fast` — PASS  
- [ ] `TELLER_TEST_PHASE=17 npm run test:phase` — PASS (or current phase)  
- [ ] New SQL patch identified? If yes → **STOP for manual apply** before prod verify  
- [ ] `npm run verify:patch:NNN:static` for any new patch  
- [ ] `npm run build` — PASS  

## Database patch (if any)

- [ ] Confirm correct Supabase project (not staging)  
- [ ] Apply patch SQL in Supabase SQL editor  
- [ ] Run static verify  
- [ ] `TELLER_CONTROLLED_PROD_TEST=1 npm run verify:phase17e:production` (or phase-specific)  

## Deploy

- [ ] `git push` to deployment branch  
- [ ] Vercel build completes — note deployment ID  
- [ ] Record commit SHA + deployment ID in release log  

## Post-deploy smoke

- [ ] `GET /api/ready` returns `{ ok: true, db: "connected" }`  
- [ ] Login smoke test  
- [ ] HFAC baseline unchanged (8 docs / 17 journals)  
- [ ] Journal balance: 0 unbalanced (`verify-phase17e-production`)  
- [ ] `npm run test:full` — PASS (final gate)  

## Rollback criteria

Rollback Vercel deployment if:

- SEV-1 security or data exposure  
- Widespread 5xx after deploy  
- Accounting integrity failure introduced by **application** code  

**Application rollback does NOT rollback database.** DB issues require forward-fix patch.

## Rollback procedure

1. Vercel Dashboard → Deployments → select last known good  
2. Promote / redeploy previous deployment  
3. Verify `/api/ready` and journal balance  
4. Open incident record if SEV-1/2  

## Documentation

- [ ] Update phase doc closeout if completing a phase slice  
- [ ] Record patch apply date in `PHASE-17E-OPERATIONS.md` ledger if applicable  
