# Kansas Sales & Compensating Use Tax — Teller Phase 15H Source Map

**Pack version:** `KS-2026.1`  
**Last reviewed:** 2026-09-11  
**Scope:** V1 reference configuration — not complete Kansas tax law automation.

## Authoritative sources

| Topic | Source | URL |
|-------|--------|-----|
| State rate (6.50%) & use tax overview | Pub. KS-1510 Sales Tax and Compensating Use Tax | https://www.ksrevenue.gov/pub1510.html |
| Statutory state rate | K.S.A. 79-3603 | https://www.kslegislature.gov/b2025_26/laws/079_000_0000_chapter/079_036_0000_article/079_036_0003_section/079_036_0003_k/ |
| Local jurisdiction rates (reference) | Pub. KS-1700 / KDOR rate locator | https://www.ksrevenue.gov/ |

## Teller mappings (KS-2026.1)

| Config item | Treatment | Source basis | Limitations |
|-------------|-----------|--------------|-------------|
| State rate component 6.50% @ `US-KS` | Active | K.S.A. 79-3603 / Pub. KS-1510 | Does not include all local rates |
| Finney County local 1.45% @ `US-KS-FINNEY` | Active (reference fixture) | Pub. KS-1510 training example (7.95% combined outside Garden City) | Example only — verify current rate before production reliance |
| `general_merchandise`, `equipment`, `materials` | `taxable` | KS retailers sales tax on TPP | Exemptions/overrides apply |
| `labor`, `installation`, `service`, `maintenance_agreement`, `shipping` | `needs_review` | Fact-dependent classifications | No automatic labor/service taxability |
| Sourcing model | `destination` | Pub. KS-1510 destination-based sourcing | Requires ship-to/service location inputs |
| Unknown county local rate | `needs_review` | V1 partial local table | e.g. `US-KS-JOCO` without seeded local component |
| Resale exemption type | `ks_resale` certificate label | KS DOR exemption framework | No authenticity validation in V1 |

## HVAC reference industry

Same generic category mapping as other industries. Unsupported fact patterns return `needs_review` rather than guessed taxability.

## Not in V1

- Automated nexus determination
- Complete KS-1700 jurisdiction import
- Food rate reductions (K.S.A. 79-3603d) as separate category program
- Compensating use tax purchase workflows beyond Phase 15E engine integration
