# Where contract.json comes from

`contract.json` is a copy of `docs/kriya-harness/contract.json` in the Kriya
repository, exported from `lib/harness/contract.ts` by
`scripts/harness-contract.ts` there (HD-03). Do not edit it here: copy it
again from Kriya and update the hash below in the same change.

| Field | Value |
| --- | --- |
| Copied | 2026-11-01 (again, for H8: handoff and pull) |
| From | Kriya repository `main` at `9a51a12` plus uncommitted work (the file isn't committed there yet) |
| sha256 | `9fce0dc02d8236070e430b1b0aed3092772a6e2fd1f7b63cd61251794f6a3403` |

When the Kriya side commits the file, replace "From" with that commit.
`tests/contract.test.js` checks the hash, so a hand edit fails.
