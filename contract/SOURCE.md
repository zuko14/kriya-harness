# Where contract.json comes from

`contract.json` is a copy of `docs/kriya-harness/contract.json` in the Kriya
repository, exported from `lib/harness/contract.ts` by
`scripts/harness-contract.ts` there (HD-03). Do not edit it here: copy it
again from Kriya and update the hash below in the same change.

| Field | Value |
| --- | --- |
| Copied | 2026-11-10 (again: `assembly` in `GET /editing/features`, for TP1 of the top-tier plan) |
| From | Kriya repository `main` (uncommitted) on `5710890` |
| sha256 | `59fbea9ae55b489a6c600df1b565d57bde20bdb3d52ab6731662ffe18b9baff4` |

When the Kriya side commits the file, replace "From" with that commit.
`tests/contract.test.js` checks the hash, so a hand edit fails.
