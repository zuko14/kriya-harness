# Where contract.json comes from

`contract.json` is a copy of `docs/kriya-harness/contract.json` in the Kriya
repository, exported from `lib/harness/contract.ts` by
`scripts/harness-contract.ts` there (HD-03). Do not edit it here: copy it
again from Kriya and update the hash below in the same change.

| Field | Value |
| --- | --- |
| Copied | 2026-11-04 (again: harness upgrade U1/U3, `context_length_exceeded` and GET /models `contextWindow`/`maxOutputTokens`) |
| From | Kriya repository `main` at `f462913` plus uncommitted harness-upgrade work |
| sha256 | `207c384129fe34fcc7126dfdd164db5a73447ca8121b90e0d3fe54820963f965` |

When the Kriya side commits the file, replace "From" with that commit.
`tests/contract.test.js` checks the hash, so a hand edit fails.
