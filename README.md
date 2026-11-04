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
| `kriya [--mode <mode>] [--no-open] [--port <n>]` | DeepSeek Harness's Web UI on `127.0.0.1`, with Kriya's models |
| `kriya run [--mode <mode>] "<job>" [--json]` | One job; prints the answer; exit 0 done, 1 failed |
| `kriya acp` | The same agent for editors that speak ACP v1 (Agent Client Protocol): your editor starts it and talks over stdin/stdout |
| `kriya handoff ["<note>"]` | Hands this repository's uncommitted work (HEAD must be on GitHub) to your Kriya agent in a cloud workspace; prints the thread's link |
| `kriya pull [<workspace id>]` | Brings a workspace's latest changes back on a new branch `kriya/pull-<id>` at its base commit (default: your last handoff) |
| `kriya serve [folder]` | Lets your Kriya agents' cloud tasks work on this machine, in new subfolders of `<folder>` (default: this folder), while it runs; see SAFETY.md |
| `kriya skills [link <folder> [--only a,b] \| unlink <name> \| off <name> [--everywhere] \| on <name>]` | Lists the `SKILL.md` skills the agent sees in this folder, which are off and the catalog's size; links a folder of skills into `~/.kriya/skills`; turns a skill off for this project (or everywhere) or back on |
| `kriya doctor` | Checks Node, the profiles, the sign-in and the gateway |
| `kriya logout` | Signs out here and revokes the device in Kriya |
| `kriya --version` | Versions of Kriya Harness and DeepSeek Harness |

Modes (`--mode`, default `ask`): `ask` works in this folder and asks before
anything beyond it; `auto` works in this folder without asking and refuses
the rest; `read` changes nothing; `plan` (`kriya run`) answers with a plan
and changes nothing; `full` has no sandbox and asks nothing. Details and
limits in [SAFETY.md](SAFETY.md). In the Web UI, switch with the Permissions
control or `/permission`, and plan first with `/plan`.

The Kriya loop's verify step (H14a; **on by default since 0.2.0**, `--no-loop`
or `KRIYA_LOOP=off` turns it off) gives the agent `kriya_verify`, which runs the check you confirmed
for the project and reports pass, fail, or blocked after 4 failed runs, from
its exit code alone. The agent is told never to say the work passes without
it. `kriya verify` lists the checks the project defines (package.json
scripts, Makefile, cargo, go, pytest…), `kriya verify use <number>` (or a
command in quotes) confirms one, and `kriya verify clear` forgets it. The
tool takes no command, so the model can't change what passing means; the
check runs like any bash command, in the session's folder under its mode's
sandbox. Without a confirmed check nothing runs and the work is "not
checked". Every run is recorded per session in
`~/.kriya/progress/<project>/<session>.md` (never in the project). Without
`--loop` the agent is exactly as before.

A pass covers the files it ran on (harness upgrade U8): each run records a
fingerprint of the working tree (HEAD, the changed and untracked files and
their contents, read without writing anything to `.git`). If files change
after the last pass, the verdict reads "not checked" again, and before the
turn ends the agent is sent back once to run the check again. A pass whose
work changed test or check files (tests, `package.json`, `pytest.ini` and
the like) names them, so you can see a test that was changed to pass.

Plans and steps (H14c, with the loop): for a task with several parts the
agent records a plan with `kriya_plan` (a goal and at most 7 ordered steps,
each with what is true when it's done), then runs each with `kriya_step`. A
step is built by a fresh agent that sees only the goal, the plan and its own
step; the harness then runs the check; on a failure a new builder gets the
check's real output, up to 4 runs, then the step is blocked and the agent
stops. Steps run in order, builders can't plan or run steps themselves, and
a session makes at most 3 plans (a new plan can't wipe out "blocked"
forever). The plan and every run are in the session's progress file. For a
single run, `KRIYA_VERIFY_CHECK="<command>"` in your shell sets the check
without `kriya verify use` (benchmarks use it with the visible tests).

Step checkpoints (H14b, with the loop): before each tool call that can
change files (write, edit, bash and the like), the working tree, tracked and
untracked files but never ignored ones, is saved as a commit on Kriya's own
ref, `refs/kriya/checkpoints/<session>/<n>`. `kriya undo` puts the files
back one step, `kriya undo --list` shows the checkpoints and `kriya undo
<number>` goes to one. Your branches, tags, stash, HEAD and index are never
touched (Kriya stages into its own index file under `~/.kriya`), so it works
mid-rebase too; what an undo replaces is saved first, so an undo can be
undone. Not in Read only, where nothing changes; outside a git repository
there are no checkpoints. The newest 100 per session are kept, and
`refs/kriya/*` isn't pushed by a normal `git push`.

Why these defaults (0.2.0): on KriyaBench's capability tasks with DeepSeek
V4.1 Flash, three runs each, the loop with the turn budget passed 18 of 21
task runs against 14 of 21 without them (every disagreement in its favour;
not yet significant at 95% with this few tasks), at about 1.4× the spend per
passed task. Confirm your project's check (`kriya verify`, then `kriya
verify use <number>`): the gain comes from running it. Full numbers in the
Kriya repository, `docs/kriya-harness/harness_upgradation/BENCHMARK_PLAN.md`.

Turn budget (harness upgrade U2; **on by default since 0.2.0**, `--no-budget`
or `KRIYA_BUDGET=off` turns it off) bounds each turn by code: at most 150 steps (`KRIYA_MAX_STEPS`),
60 minutes (`KRIYA_TURN_MINUTES`) and 10 identical tool calls in a row
(`KRIYA_MAX_REPEATS`). Five steps before the step limit (or at 90% of the
time) the agent is told once to wrap up; at a limit the next step is
refused, so the turn ends "blocked" and `kriya run` exits 1, never
"completed". Each step's builder (`kriya_step`) has its own budget.
With `--no-budget` turns are unbounded, as before 0.2.0.

Kept request (beta, harness upgrade U7): `kriya --anchor` or `kriya run
--anchor` keeps every message you send in the session, word for word, in a
late part of the system prompt, which compaction never condenses: a
requirement survives even when the conversation's summary leaves it out.
Only your own messages, never tool output. Without `--anchor` the agent is
exactly as before.

Web UI tabs (right sidebar): **Overview** (this computer, the folder, the
GitHub repository and branch, context and usage, changes, background tasks,
connectors), **Progress** (goal → plan → build → verify → done from the
loop's own check runs) and **Preview** (an app on this computer, localhost
only, in a frame).

Agent's browser (beta, off; `kriya --browser-tools`, `kriya run
--browser-tools`, `KRIYA_BROWSER=on`): the agent tests and reviews apps on
this computer with your installed Google Chrome (headless, its own profile
in `~/.kriya/browser/`): `browser_open`, `browser_read`,
`browser_screenshot`, `browser_click`, `browser_type`, `browser_press`,
`browser_console`, `browser_network`. Only localhost addresses open (never
the Web UI's own port); a link elsewhere is refused before it is sent and
the page stays. In Read only it can open and read, not click or type. The
Preview tab's "Agent's browser" shows the same page live and lets you click,
scroll and type into it.

Loop v2 (beta, off; `kriya --loop-v2`, `kriya run --loop-v2`,
`KRIYA_LOOP_V2=on`): plan steps name the earlier steps they need, so a
blocked step skips only what depends on it; a failed check is classified
(syntax, type, assertion, environment, timeout) and cut to its failing
lines; a pass that changed tests must also pass with the committed tests;
an attempt that fails further from passing is set aside (kept in `kriya
undo --list`); a failure seen twice is proposed as a rule, which the agent
sees only after `kriya rules confirm <number>`. No extra model calls; not
yet measured on a real model. Without `--loop-v2` the loop is exactly v1.

Model limits (harness upgrade U3): when Kriya reports a tier's context
window and output cap (`GET /models`), the tier declares them to DeepSeek
Harness, capped at a 262,144-token working window, so compaction starts
before a smaller model's window is full; a tier without them keeps DeepSeek
Harness's defaults. When the provider says a conversation is too long,
Kriya answers `context_length_exceeded`, which DeepSeek Harness compacts and
retries. `kriya usage [--json]` prints this month's spend and limit
(KriyaBench's `--meter` reads it).

Models are Kriya's tiers: `balanced`, `budget`, `escalation`. A session
starts on `balanced`, or on the best tier your plan allows. Your plan decides
which are allowed and its monthly limit, and the model picker offers only
those (read from Kriya when `kriya` starts; restart it after a plan change).
A session saved on a tier your plan no longer has shows "Select model":
pick one of your plan's tiers and carry on.

Skills: any folder of `<name>/SKILL.md` skills works, including the ones
written for Claude Code (superpowers, ponytail, ECC), without conversion:

```bash
kriya skills link ~/.claude/plugins/cache/ponytail/ponytail/<version>/skills
kriya skills
```

The agent sees a catalog (each skill's name and description) and loads a
skill when it needs it; type `/<name>` to use one directly. In the browser
(`kriya`), the **Skills** page in the sidebar lists every skill the agent
sees, where it comes from and what the list costs per request. It edits the
skills you own (each save is checked by DeepSeek Harness's own parser and
undone if the agent couldn't read it), turns a linked skill into your own
copy (its source stays untouched), creates new ones and unlinks.
`node scripts/skill-eval.js` measures automatic selection on the real
client (it spends your allowance). The catalog goes
with every request, so turn off what a project doesn't need: each row on
the Skills page has a switch (on, off in this project, off everywhere;
`kriya skills off <name>` in a terminal), and the page shows what the
list costs and what the skills that are off save. A skill that's off is
out of the agent's list, its `skill` tool and `/name` in every profile
(browser, `kriya run`, editors), from the agent's next step; its files are
never touched. Switches live in `~/.kriya/skill-switches.json`, per
project (its git root). Skills are guidance only; Claude Code hooks and slash commands don't
carry over, and a skill never adds a tool or skips an approval. Skills in a
project's `.dsh/skills` or `.agents/skills`, and in `~/.agents/skills`, are
read too; your Kriya agent's own skills come on top.

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
- `plugins/projects/` is the **Projects** page in the sidebar: the folders
  on this computer that look like projects (a `.git`, `package.json`,
  `pyproject.toml`, `Cargo.toml`, `go.mod` and similar) in `~/Developer`,
  `~/Projects`, `~/code` and the other usual places, one level of group
  folders deep, plus the folder you started `kriya` in. **Open** makes the
  folder a workspace and starts a session there. macOS asks before an app
  reads Desktop, Documents or Downloads, so those are searched only when
  you name them: `KRIYA_PROJECT_ROOTS=~/Documents:~/work kriya`. Read-only;
  it lists names, paths and times.
- One product, one language: the bundle turns off DeepSeek Harness's
  Creator mode (which writes DSH plugins), its Plugins page and Settings →
  Built-in plugins, and the brand plugin pins Kriya's English (`en-IN`, a
  language pack over DSH's English with Kriya's own words where DSH names
  itself); DSH's 中文 is not offered.
- `plugins/changes/` is the **Changes** tab in the right sidebar (next to
  DeepSeek Harness's own Workspace files, Terminal and Browser): every file
  changed in the session's folder against HEAD (staged, unstaged and
  untracked, renames and binaries too) with lines added and removed, and
  each file's diff, refreshed every few seconds while it's on screen.
  Read-only; the browser names a session, never a folder, and a diff is
  only made for a file git lists as changed.
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
