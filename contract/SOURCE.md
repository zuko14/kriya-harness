# Where contract.json comes from

`contract.json` is a copy of `docs/kriya-harness/contract.json` in the Kriya
repository, exported from `lib/harness/contract.ts` by
`scripts/harness-contract.ts` there (HD-03). Do not edit it here: copy it
again from Kriya and update the hash below in the same change.

| Field | Value |
| --- | --- |
| Copied | 2026-11-04 (again: GET /models `bodyEncodings`, the gzip+base64 request bodies) |
| From | Kriya repository `main` at `59aed94` plus uncommitted body-encoding work |
| sha256 | `de7b652cac3d5da1825ce0d22a724fec888856ddaec4cba10b7882015983fb45` |

When the Kriya side commits the file, replace "From" with that commit.
`tests/contract.test.js` checks the hash, so a hand edit fails.
