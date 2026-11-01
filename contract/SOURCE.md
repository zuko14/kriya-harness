# Where contract.json comes from

`contract.json` is a copy of `docs/kriya-harness/contract.json` in the Kriya
repository, exported from `lib/harness/contract.ts` by
`scripts/harness-contract.ts` there (HD-03). Do not edit it here: copy it
again from Kriya and update the hash below in the same change.

| Field | Value |
| --- | --- |
| Copied | 2026-11-01 (again, for H5: the three approval routes) |
| From | Kriya repository `main` at `9a51a12` plus uncommitted work (the file isn't committed there yet) |
| sha256 | `8df89a41fb560bbc374f3a348a29e7cea1f1a5f71c52d8d15159046c970c8283` |

When the Kriya side commits the file, replace "From" with that commit.
`tests/contract.test.js` checks the hash, so a hand edit fails.
