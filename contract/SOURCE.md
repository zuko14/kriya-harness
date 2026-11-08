# Where contract.json comes from

`contract.json` is a copy of `docs/kriya-harness/contract.json` in the Kriya
repository, exported from `lib/harness/contract.ts` by
`scripts/harness-contract.ts` there (HD-03). Do not edit it here: copy it
again from Kriya and update the hash below in the same change.

| Field | Value |
| --- | --- |
| Copied | 2026-11-08 (again: decision cards, notes, new recordings; dispatch kind `edit`, the editing preview routes) |
| From | Kriya repository `main` (uncommitted) on `d46bb0c` |
| sha256 | `65e1614719f28861bc11b2368c97e90ddff81ac070591a48366ac846ededae88` |

When the Kriya side commits the file, replace "From" with that commit.
`tests/contract.test.js` checks the hash, so a hand edit fails.
