# Where contract.json comes from

`contract.json` is a copy of `docs/kriya-harness/contract.json` in the Kriya
repository, exported from `lib/harness/contract.ts` by
`scripts/harness-contract.ts` there (HD-03). Do not edit it here: copy it
again from Kriya and update the hash below in the same change.

| Field | Value |
| --- | --- |
| Copied | 2026-11-10 (again: `motion` and `customMotion` in `GET /editing/features`, for the motion kit) |
| From | Kriya repository `main` (uncommitted) on `3a0c769` |
| sha256 | `b6fa9d2424249e8fd9e8b3ab806f7178ef5977bbd4b9d11f12ef85b385f0d6fb` |

When the Kriya side commits the file, replace "From" with that commit.
`tests/contract.test.js` checks the hash, so a hand edit fails.
