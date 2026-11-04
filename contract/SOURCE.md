# Where contract.json comes from

`contract.json` is a copy of `docs/kriya-harness/contract.json` in the Kriya
repository, exported from `lib/harness/contract.ts` by
`scripts/harness-contract.ts` there (HD-03). Do not edit it here: copy it
again from Kriya and update the hash below in the same change.

| Field | Value |
| --- | --- |
| Copied | 2026-11-04 (again: the Control Center routes /daemon/hello, /dispatch/next, /dispatch/{id}, /runs) |
| From | Kriya repository branch `feat/harness-control-center` (uncommitted) on `a06dbaa` |
| sha256 | `d1721c02c4c5e9384f361493b7dbd73eb8a42943c7fbd77689234971687b7877` |

When the Kriya side commits the file, replace "From" with that commit.
`tests/contract.test.js` checks the hash, so a hand edit fails.
