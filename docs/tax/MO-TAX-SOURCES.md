# Missouri Sales & Use Tax — Teller Phase 15H Source Map

**Pack version:** `MO-2026.1`  
**Last reviewed:** 2026-09-11  
**Scope:** V1 reference configuration — not complete Missouri tax law automation.

## Authoritative sources

| Topic | Source | URL |
|-------|--------|-----|
| State sales/use tax rate (4.225%) | Missouri Department of Revenue — Sales/Use Tax | https://dor.mo.gov/taxation/business/tax-types/sales-use/ |
| Local rate lookup (not imported wholesale in V1) | Missouri Sales & Use Tax Lookup | https://dor.mo.gov/online-services/ |
| Statutory framework | Missouri Revised Statutes Chapter 144 | https://revisor.mo.gov/main/OneSection.aspx?section=144.020 |

## Teller mappings (MO-2026.1)

| Config item | Treatment | Source basis | Limitations |
|-------------|-----------|--------------|-------------|
| State rate component 4.225% @ `US-MO` | Active | MO DOR published state rate | Does not include local/district components |
| `general_merchandise`, `equipment`, `materials` | `taxable` | MO retail TPP generally presumed taxable | Org/exemption overrides still apply |
| `labor`, `installation`, `service`, `maintenance_agreement`, `shipping` | `needs_review` | Fact-dependent under MO law | Teller does not infer contractor/RP/repair facts |
| Sourcing model | `origin_seller` | MO DOR — combined rate generally based on seller location for retail collection | Cross-border cases require destination review when ship-to state differs |
| Unknown county/city local rate | `needs_review` | V1 does not import full local rate tables | Do not silently apply state-only when local jurisdiction is specified without reference data |
| Resale exemption type | `mo_resale` certificate label | MO DOR exemption certificate framework | Teller does not validate certificate authenticity |

## HVAC reference industry

HVAC item types map to generic categories (`equipment`, `labor`, `installation`, etc.). Missouri-specific taxability is **not** hardcoded per HVAC line — fact-dependent patterns (`new_construction`, `real_property_improvement`, etc.) return `needs_review`.

## Not in V1

- Automated nexus determination
- Full Missouri local/district rate database
- Food/textbook/special-item tax programs
- Electronic filing or payment to MO DOR
