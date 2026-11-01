# Where contract.json comes from

`contract.json` is a copy of `docs/kriya-harness/contract.json` in the Kriya
repository, exported from `lib/harness/contract.ts` by
`scripts/harness-contract.ts` there (HD-03). Do not edit it here: copy it
again from Kriya and update the hash below in the same change.

| Field | Value |
| --- | --- |
| Copied | 2026-11-01 (again, for H7: skills and memory) |
| From | Kriya repository `main` at `9a51a12` plus uncommitted work (the file isn't committed there yet) |
| sha256 | `4f992fe05b07f4d152453c741daf7a14ba6d0bb26362b4e61d7b3ef388cde562` |

When the Kriya side commits the file, replace "From" with that commit.
`tests/contract.test.js` checks the hash, so a hand edit fails.
