# Where contract.json comes from

`contract.json` is a copy of `docs/kriya-harness/contract.json` in the Kriya
repository, exported from `lib/harness/contract.ts` by
`scripts/harness-contract.ts` there (HD-03). Do not edit it here: copy it
again from Kriya and update the hash below in the same change.

| Field | Value |
| --- | --- |
| Copied | 2026-11-06 (again: `images` on GET /models) |
| From | Kriya repository `main` (uncommitted) on `0d148ad` |
| sha256 | `a9c894b9fb8388dfd1b351130097cba2b4b8e84763368db1bd3dea83b4918c2d` |

When the Kriya side commits the file, replace "From" with that commit.
`tests/contract.test.js` checks the hash, so a hand edit fails.
