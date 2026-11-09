# Where contract.json comes from

`contract.json` is a copy of `docs/kriya-harness/contract.json` in the Kriya
repository, exported from `lib/harness/contract.ts` by
`scripts/harness-contract.ts` there (HD-03). Do not edit it here: copy it
again from Kriya and update the hash below in the same change.

| Field | Value |
| --- | --- |
| Copied | 2026-11-09 (again: `GET /editing/features`, for the visual scenes) |
| From | Kriya repository `main` (uncommitted) on `a2bb6ed` |
| sha256 | `8bf16886bc6b98bda3f261c9a762c7424324e9a893f5a50ff12f77c4b71ed754` |

When the Kriya side commits the file, replace "From" with that commit.
`tests/contract.test.js` checks the hash, so a hand edit fails.
