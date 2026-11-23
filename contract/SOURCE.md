# Where contract.json comes from

`contract.json` is a copy of `docs/kriya-harness/contract.json` in the Kriya
repository, exported from `lib/harness/contract.ts` by
`scripts/harness-contract.ts` there (HD-03). Do not edit it here: copy it
again from Kriya and update the hash below in the same change.

| Field | Value |
| --- | --- |
| Copied | 2026-11-23 (again: Harness 2.0 W13, the `graphics` role, `G-3D`, the `GX-*` and `FE-ASSET-LICENCE` detectors and the `scene_direction` contract; W16, `GET /mcp`; earlier frozen for the Harness 2.0 W12 release: regenerated, identical; again: Harness 2.0 W11, `TurnRequest.cartridgeOutcomes` and `GET /models` `workforce`; W2, the optional `orchestra` field of `GET /models`; W1's `cartridgeIds` and `GET /skills` item fields) |
| From | Kriya repository branch `main` (uncommitted, on `b0ed4c2`) |
| sha256 | `ebfcb72c1a6687e7bed3510be00a81662a2ed6594c1e1a9836cae46b44d6107f` |

When the Kriya side commits the file, replace "From" with that commit.
`tests/contract.test.js` checks the hash, so a hand edit fails.
