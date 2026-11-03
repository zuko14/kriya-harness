# Where contract.json comes from

`contract.json` is a copy of `docs/kriya-harness/contract.json` in the Kriya
repository, exported from `lib/harness/contract.ts` by
`scripts/harness-contract.ts` there (HD-03). Do not edit it here: copy it
again from Kriya and update the hash below in the same change.

| Field | Value |
| --- | --- |
| Copied | 2026-11-03 (again: `name` on GET /models, the owner's model per tier) |
| From | Kriya repository branch `feat/harness-loop-bench` plus uncommitted work (GET /models `name`) |
| sha256 | `9b0e5a985292f53a82b76a8ec817b03818833a03af07c9514ab256971c0b1cc6` |

When the Kriya side commits the file, replace "From" with that commit.
`tests/contract.test.js` checks the hash, so a hand edit fails.
