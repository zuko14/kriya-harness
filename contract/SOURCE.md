# Where contract.json comes from

`contract.json` is a copy of `docs/kriya-harness/contract.json` in the Kriya
repository, exported from `lib/harness/contract.ts` by
`scripts/harness-contract.ts` there (HD-03). Do not edit it here: copy it
again from Kriya and update the hash below in the same change.

| Field | Value |
| --- | --- |
| Copied | 2026-11-12 (again: `taviOrder` in `GET /editing/features`, `DaemonProject.clips` and the `order` card kind, for TP11 of the top-tier plan) |
| From | Kriya repository branch `feat/editing-live-preview-tp3` (uncommitted, on `2047db8`) |
| sha256 | `9fd143888fa4b2f5cd3ae78c3e677c0ee62ebbbd6e742e9ebc759fd44ea57111` |

When the Kriya side commits the file, replace "From" with that commit.
`tests/contract.test.js` checks the hash, so a hand edit fails.
