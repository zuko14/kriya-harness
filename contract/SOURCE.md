# Where contract.json comes from

`contract.json` is a copy of `docs/kriya-harness/contract.json` in the Kriya
repository, exported from `lib/harness/contract.ts` by
`scripts/harness-contract.ts` there (HD-03). Do not edit it here: copy it
again from Kriya and update the hash below in the same change.

| Field | Value |
| --- | --- |
| Copied | 2026-11-11 (again: `livePreview` in `GET /editing/features`, for TP3 of the top-tier plan) |
| From | Kriya repository `24d7e84` (local branch `feat/editing-live-preview-tp3`, not pushed) |
| sha256 | `855e16220cc74dfb6a4352624d553c2a700098da6b79cb1332ee8a7bbdccd003` |

When the Kriya side commits the file, replace "From" with that commit.
`tests/contract.test.js` checks the hash, so a hand edit fails.
