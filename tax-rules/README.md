# Tax rule specifications

This directory holds **authoritative tax rule data** for the Teller jurisdiction engine.

## Important

- **No state-specific business logic belongs in `src/lib/tax/`.** The engine is generic.
- **No Missouri or Kansas rule files are included by default.** Rules must be sourced from primary authorities, reviewed, and loaded deliberately.
- Do not activate a rule set until citations and effective dates are verified.

## Directory layout

```
tax-rules/
  README.md           — this file
  schema/             — JSON schema for rule set files
  pending/            — draft specs awaiting review (not loaded automatically)
  active/             — reviewed specs eligible for load (still require status: active)
```

## Rule set file format

Each file is one versioned rule pack. See `schema/rule-set.schema.json`.

Minimum fields:

- `slug`, `name`, `version`, `status`, `effectiveFrom`
- `sourceDocumentation` — links or citations to authority publications
- `jurisdictions[]` — registry keys referenced by rules/rates
- `rates[]` — versioned percentages with `sourceCitation` per rate
- `rules[]` — priority-ordered conditions + actions

## Status values

| Status | Loaded by script? | Used by engine? |
|--------|-------------------|-----------------|
| `draft` | Optional (dev only) | No |
| `reviewed` | Yes | No |
| `active` | Yes | Yes |
| `retired` | Yes (archive) | No |

## Loading rules

```bash
# Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
npm run tax-rules:load
```

The loader upserts jurisdictions, rates, and rules from `tax-rules/active/*.json`. It refuses to load files unless `status` is `reviewed` or `active` (use `--allow-draft` only in development).

## Review checklist (before setting status: active)

- [ ] Primary authority citation for each rate
- [ ] Effective dates verified
- [ ] Transaction classifications match Teller `item_type` / category vocabulary
- [ ] Professional tax review completed
- [ ] Staging validation against sample invoices
