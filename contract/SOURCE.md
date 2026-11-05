# Where contract.json comes from

`contract.json` is a copy of `docs/kriya-harness/contract.json` in the Kriya
repository, exported from `lib/harness/contract.ts` by
`scripts/harness-contract.ts` there (HD-03). Do not edit it here: copy it
again from Kriya and update the hash below in the same change.

| Field | Value |
| --- | --- |
| Copied | 2026-11-05 (again: POST /live for Remote Control) |
| From | Kriya repository `main` (uncommitted) on `0d148ad` |
| sha256 | `257c0f27d21cd951d70f7bf6feeea24d1810b67a7497e3020a234d68a98dce40` |

When the Kriya side commits the file, replace "From" with that commit.
`tests/contract.test.js` checks the hash, so a hand edit fails.
