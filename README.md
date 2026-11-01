# Kriya Harness (beta)

A Kriya agent on your own machine: it reads and changes files and runs
commands in a folder you choose, and uses your Kriya account's model
allowance. **Built on DeepSeek Harness** (MIT), as a pinned dependency
extended through its documented profile and plugin seams; DeepSeek Harness
itself isn't modified. Read [SAFETY.md](SAFETY.md) first.

Status: alpha (track H, phase H4). Not published to npm yet.

## Use

Needs Node 24.9 or later.

```bash
npm install
node bin/kriya.js login --url https://<your Kriya address>
```

| Command | What it does |
| --- | --- |
| `kriya login [--url …] [--no-browser]` | Signs this device in: shows a code, opens Kriya's connect page, waits for you to approve it there |
| `kriya [--no-open] [--port <n>]` | DeepSeek Harness's Web UI on `127.0.0.1`, with Kriya's models |
| `kriya run "<job>" [--json]` | One job; prints the answer; exit 0 done, 1 failed |
| `kriya doctor` | Checks Node, the profiles, the sign-in and the gateway |
| `kriya logout` | Signs out here and revokes the device in Kriya |
| `kriya --version` | Versions of Kriya Harness and DeepSeek Harness |

Models are Kriya's tiers: `balanced` (default), `budget`, `escalation`. Your
plan decides which are allowed and its monthly limit.

## How it's put together

- `bin/kriya.js` signs in, prepares the Kriya profiles in `~/.kriya`
  (`DSH_HOME`) and starts DeepSeek Harness's own launcher with
  `--profile kriya` or `--profile kriya-run`.
- `bundle/cordis.patch.yml` is the "kriya" bundle each profile stacks on
  `dsh-base`: the Kriya gateway as the only model route, Kriya's
  `balanced` tier as the default, and DeepSeek's account, models, web
  search and telemetry rows disabled.
- `plugins/brand/` is the Kriya look for the Web UI ([DESIGN.md](plugins/brand/DESIGN.md)):
  Kriya's palette through DeepSeek Harness's theme token layer, Geist,
  Fraunces and JetBrains Mono embedded, the brand slots (sidebar mark and
  name), the start screen where the K is stitched in, and Kriya's tab title
  and icon. The bundle turns DeepSeek's official brand row off. Edit
  `plugins/brand/src/client.js`, then `npm run build:brand`.
- `contract/contract.json` is the Kriya Harness API contract, copied from
  the Kriya repository ([contract/SOURCE.md](contract/SOURCE.md)).
- `plugins/approvals/` sends DeepSeek Harness's approval questions to Kriya
  too: answer in the local prompt or in Kriya on your phone, and the first
  answer wins. With no answer from either (Kriya unreachable, the request
  expired), the action is refused. In `kriya run` the phone is the only
  place to answer.
- `plugins/mirror/` sends a summary of each turn (its answer and the tools
  it used) to a thread in Kriya, so your phone shows progress, but only
  when you turn the mirror on for this computer in Kriya (Account →
  Devices). "Full" also sends each tool's arguments and output. Turns wait
  in `~/.kriya/mirror-queue.json` while Kriya is unreachable.
- Skills and memory, handoff and editor (ACP) support are later phases
  (H7, H8, H11).

## Develop

```bash
npm run check          # exact pins, notices and theme build current, all tests
npm run build:brand    # rebuild plugins/brand/client.js (fonts inlined)
npm run release:check  # the release gate, including the license allow-list
npm run dump-config    # re-record expected/*.dump.yml after a reviewed DSH bump
npm run notices        # regenerate THIRD_PARTY_NOTICES.md from the lockfile
```

Tests use `tests/fake-kriya.js` on `127.0.0.1` and boot the real, pinned
DeepSeek Harness; nothing reaches a real Kriya or model provider.

Upgrading DeepSeek Harness: change only the version, run `npm run check`,
review the `expected/` diff from `npm run dump-config`, record the result.
