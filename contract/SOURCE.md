# Where contract.json comes from

`contract.json` is a copy of `docs/kriya-harness/contract.json` in the Kriya
repository, exported from `lib/harness/contract.ts` by
`scripts/harness-contract.ts` there (HD-03). Do not edit it here: copy it
again from Kriya and update the hash below in the same change.

| Field | Value |
| --- | --- |
| Copied | 2026-11-24 (again: own models, `POST /own-usage` and `GET /models` `ownModels`; the Developer cockpit, `GET /models` `cockpit`; S-3, `runProof`, the schema of a run's `result.proof`; S-1, the optional `localModels` field of `GET /models`; earlier 2026-11-23: Harness 2.0 W13, the `graphics` role, `G-3D`, the `GX-*` and `FE-ASSET-LICENCE` detectors and the `scene_direction` contract; W16, `GET /mcp`; earlier frozen for the Harness 2.0 W12 release: regenerated, identical; again: Harness 2.0 W11, `TurnRequest.cartridgeOutcomes` and `GET /models` `workforce`; W2, the optional `orchestra` field of `GET /models`; W1's `cartridgeIds` and `GET /skills` item fields) |
| From | Kriya repository branch `main` (uncommitted, on `1b4a742`) |
| sha256 | `84a25644fbe011d469e4e321f77893a072063d34e4bd85dc61f9f11abffbebae` |

When the Kriya side commits the file, replace "From" with that commit.
`tests/contract.test.js` checks the hash, so a hand edit fails.
