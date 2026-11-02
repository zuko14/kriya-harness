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
| `kriya acp` | The same agent for editors that speak ACP v1 (Agent Client Protocol): your editor starts it and talks over stdin/stdout |
| `kriya handoff ["<note>"]` | Hands this repository's uncommitted work (HEAD must be on GitHub) to your Kriya agent in a cloud workspace; prints the thread's link |
| `kriya pull [<workspace id>]` | Brings a workspace's latest changes back on a new branch `kriya/pull-<id>` at its base commit (default: your last handoff) |
| `kriya serve [folder]` | Lets your Kriya agents' cloud tasks work on this machine, in new subfolders of `<folder>` (default: this folder), while it runs; see SAFETY.md |
| `kriya doctor` | Checks Node, the profiles, the sign-in and the gateway |
| `kriya logout` | Signs out here and revokes the device in Kriya |
| `kriya --version` | Versions of Kriya Harness and DeepSeek Harness |

Models are Kriya's tiers: `balanced` (default), `budget`, `escalation`. Your
plan decides which are allowed and its monthly limit.

## How it's put together

- `bin/kriya.js` signs in, prepares the Kriya profiles in `~/.kriya`
  (`DSH_HOME`) and starts DeepSeek Harness's own launcher with
  `--profile kriya`, `--profile kriya-run` or `--profile kriya-acp`.
- `bundle/cordis.patch.yml` is the "kriya" bundle each profile (`kriya`,
  `kriya-run`, `kriya-acp`) stacks on `dsh-base`: the Kriya gateway as the
  only model route, Kriya's `balanced` tier as the default (for ACP
  sessions too), and DeepSeek's account, models, web search and telemetry
  rows disabled.
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
- `plugins/kriya-tools/` brings your Kriya agent's skills into the harness
  (your own local skills win a name) and two tools: `kriya_memory_search`
  for its notes and `kriya_memory_save`, whose notes stay unconfirmed
  until you confirm them in Kriya.
- `plugins/kriya-handoff/` is `kriya handoff` and `kriya pull`. The patch
  is the working tree against HEAD (untracked and binary files included,
  ignored ones left out, your index untouched), sent with its sha256; the
  cloud workspace starts from GitHub at HEAD and applies it. A pull checks
  the sha256, needs a clean tree and changes nothing if the patch doesn't
  apply.
- `src/world.js` is `kriya serve` (H10, HD-12): one outbound WebSocket to
  kriya-relay, whose frames go to track C's own runner
  (`src/runner.bundle.js`, generated from the Kriya repository's
  `runner/index.ts`; the rebuild command is its first line), one per
  workspace, each in its own fresh subfolder.
- `kriya acp` is DeepSeek Harness's ACP app (`dsh-acp-app`) with the same
  Kriya bundle: sessions start on Kriya's `balanced` tier (the editor's
  model picker lists Kriya's three tiers only), with the same tools,
  skills, memory, phone approvals (the editor's permission prompt and your
  phone; first answer wins), mirror and permission defaults as `kriya`.
  Stdout carries only protocol frames; kriya's own messages go to stderr.

## Develop

```bash
npm run check          # exact pins, notices and theme build current, all tests
npm run build:brand    # rebuild plugins/brand/client.js (fonts inlined)
npm run release:check  # the release gate: pins, licenses (allow-list or a decided exception), notices
npm run sbom           # the release's SBOM (CycloneDX JSON) on stdout, from the lockfile
npm run dump-config    # re-record expected/*.dump.yml after a reviewed DSH bump
npm run notices        # regenerate THIRD_PARTY_NOTICES.md from the lockfile
```

Tests use `tests/fake-kriya.js` on `127.0.0.1` and boot the real, pinned
DeepSeek Harness; nothing reaches a real Kriya or model provider.

Upgrading DeepSeek Harness: change only the version, run `npm run check`,
review the `expected/` diff from `npm run dump-config`, record the result.
A package outside the license allow-list needs an owner decision recorded in
`notices-exceptions.json` for its exact version and license; the release
gate fails on a new version, a changed license or a stale exception.
