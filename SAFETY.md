# Kriya Harness safety notice (beta)

Kriya Harness is a **beta**. It is built on DeepSeek Harness, which describes
itself as experimental developer-preview software that has not had a
security audit and expects breaking changes. Kriya hasn't changed that: do
not treat Kriya Harness as secure or production-ready. `kriya` shows this
notice the first time it runs.

## Where to run it

- Start it in **one project folder** that is under version control or
  backed up, and commit your work before you start.
- Never start it in `/`, your home folder, or a folder you can't afford to
  lose (photos, documents, other projects). The agent starts in the folder
  you open it in.
- Sign out on machines you share (`kriya logout`).

## On by default since 0.2.0

- **The Kriya loop.** Before each tool call that can change files, the
  working tree is saved as a commit on Kriya's own git ref
  (`refs/kriya/checkpoints/…`, the newest 100 per session); your branches,
  tags, index, stash and HEAD are never touched, and `refs/kriya/*` isn't
  pushed by a normal `git push`, but the objects are in your repository's
  `.git`. The agent's `kriya_verify` runs only the check you confirmed, under
  the session's own mode; without one, nothing runs and work is "not
  checked". `--no-loop` turns all of this off.
- **The turn budget.** A turn stops at 150 steps, 60 minutes or 10 identical
  tool calls in a row, and ends "blocked" rather than "completed".
  `--no-budget` turns it off.
- Neither changes a mode, a sandbox or an approval.

## Harness 2.0 workforce: everything off by default

None of this runs unless you turn it on: a flag on `kriya run`, or the
variable beside it set to `on` for any way of starting Kriya Harness
(the Web UI takes the variables, not the flags). Left off, behaviour is
today's, byte for byte. `--cartridges`, `--orchestra`, `--gates`, `--critic` and `--milestones` need the loop.

| Flag | Variable | What it does |
| --- | --- | --- |
| `--cartridges` | `KRIYA_CARTRIDGES` | Each plan step's builder gets one role's guidance from Kriya (frontend, backend, security…), chosen by code |
| `--orchestra` | `KRIYA_ORCHESTRA` | Builders run on a cheaper level; the stronger level takes over when a step is stuck. Only the levels your plan allows |
| `--gates` | `KRIYA_GATES` | The deterministic gates below run after your own check passes |
| `--critic` | `KRIYA_CRITIC` | After a pass, a read-only reviewer may earn one polish attempt, kept only if every check still passes |
| `--milestones` | `KRIYA_MILESTONES` | Long work as at most 12 plans in a ledger, each done only when every step passed your check |
| `--repo-tools` | `KRIYA_REPO_TOOLS` | Typed git and GitHub tools through **your own** `git` and `gh` sign-in (below) |
| `--mcp` | `KRIYA_MCP` | Tools from MCP servers in Kriya's owner-reviewed registry that need no sign-in (below) |
| `--deploy` | `KRIYA_DEPLOY` | The release check, and preview and production deploys through **your own** provider CLI, each approved by you (below) |
| `--grounding` | `KRIYA_GROUNDING` | `api_lookup`, `api_changes`, `api_version`: facts about your installed packages read from their own type definitions, stubs, changelogs and lockfiles. Nothing is imported or run, nothing is fetched, and nothing outside the project folder is read |

Plans stay at most 7 steps and 4 attempts per step with every one of them on.

### The gates (`--gates`)

A gate is fixed code in this package. Its settings are data you or the
plan's contracts give it; nothing a model writes can be a gate's command,
pattern or pass condition. A gate passes, fails (the builder gets the
failure, like a failing check), or says **not checked** with a reason
(a tool or stack missing, Read only mode): not checked is never a pass.
Gates run only after the check you confirmed passed. In Read only mode no
gate that starts or writes anything runs. Tools are used only if your
project or `PATH` already has them; Kriya installs nothing. Commands a gate
runs go through the same runner and time limit as your check (`psql` and
`semgrep` stop after 5 minutes), and each request to your app after
10 seconds, with a budget of requests per gate.

| Gate | What it checks | Runs what |
| --- | --- | --- |
| G-CONTRACT | Contracts under `.kriya/contracts/` parse, match their schema and weren't changed by a step that doesn't own them | Nothing but reading files |
| G-DETECT | Fixed banned patterns in the files the step changed (raw colours, SQL built from strings, empty catches…) | Nothing |
| G-SECRETS | No secret in the lines the step added (key shapes, private keys, high-entropy values). Findings name file and line, **never the value** | `gitleaks` if installed |
| G-FLAKE | Your check gives the same result three times in a row | Your confirmed check, 3× |
| G-TRACE | Every acceptance item (AC-1, AC-2…) in the step's done-when has a passing test of that name | Reads your check's output |
| G-UI | Each route and state renders at 360, 390 and 1440 px, light and dark, with no console error, failed request, overflow or layout shift | A new page in the agent browser's Chrome, on your **local** app only |
| G-A11Y | Accessible names, headings, focus, contrast; axe-core if your project has it | The G-UI pages |
| G-STACK | Migrations apply (up, down, up) and tenant tables have RLS | `psql` against your **local** database |
| G-API | Responses match the API contract; bad input gives 4xx, never 5xx; idempotent operations hold | Requests to your **local** app |
| G-TENANT | One test identity can't read or change another's data, with positive controls | Requests to your **local** app, as two test identities from `.kriya/gates/tenants.json` |
| G-SAST | Dangerous code patterns | `semgrep` with **your project's own rules file** (as committed), metrics off; never `--config auto` or a registry, which would fetch rules |
| G-DATA | A pipeline gives the same output twice on your fixture | The pipeline command you confirmed |
| G-EVAL | A model change doesn't fall below its recorded baseline | The eval command you confirmed |
| G-SAN | Native builds are warning-free and sanitizer-clean | Your toolchain |
| G-IAC | Infrastructure validates and passes your policy tool | Your installed IaC and policy tools, offline |
| G-SIM | A mobile build launches in the simulator | Your installed toolchain |

Settings a builder could edit (Semgrep rules, fixtures, eval files) are read
as they are at the plan's starting commit, so a step can't weaken its own
gate. Screenshots and reports go to `~/.kriya/evidence/` (outside your
project, so the agent can't edit what a gate saw), and their sha256 is
recorded.

### Repository tools (`--repo-tools`)

They use the `git` and `gh` you're already signed in to. Kriya never reads a
credential: no `gh auth token`, no git credential store, and remotes are shown
as host and path only. If `gh` is signed out you're told to run `gh auth login`
yourself; nothing ever asks you for a password.

- **Reads** (status, diff, log, a pull request, its checks, failing CI lines,
  an issue) run freely. Text from GitHub is other people's: it's marked
  untrusted and known secret shapes are redacted before the agent sees it.
- **Branch, commit, push and draft pull request** each ask you first, with the
  exact branch, files or commits. Auto, Read only and Full access modes can't
  ask, so they refuse.
- A branch is always `kriya/<name>`; it isn't made over uncommitted changes.
- A commit holds only files this session changed, never an `.env` file (only
  `.env.example`), with a Conventional Commit subject of at most 72 characters.
- A push is only of a `kriya/` branch, never the default branch, never forced.
  G-SECRETS checks every outgoing commit first and stops the push if it finds
  what looks like a secret (it names file and line, never the value).
- Pull requests are drafts. There is no tool to merge, close, delete a branch,
  force-push, comment, release or tag: you do those.
- After a draft pull request Kriya polls its checks (code, no model) every
  30 seconds for up to 20 minutes, and tells the agent which failed so it can
  ask you about a fix step.
- With repository tools on, "the code before this session" is the commit the
  plan started from, so a commit made during the session can't turn weakened
  tests into the new originals.

### Releases and deploys (`--deploy`, `kriya release use`)

- `kriya release use --build "<cmd>" --app http://localhost:<port>` confirms,
  once per project, how a production build is made and which production
  server on this computer is checked. You start that server; Kriya doesn't.
- `release_check` (G-RELEASE) runs on a committed tree: the build, G-UI and
  G-A11Y against your production server, environment variables named in
  `.env.example` (names only), the bundle budget, the lockfile and licences,
  destructive or locking migrations, and G-SECRETS. Ready only if every line
  passes; a line that can't run withholds it.
- Deploys run your provider's own CLI, signed in by you (Kriya never reads its
  credentials), each after you approve the provider, target, commit and exact
  command. Auto, Read only and Full access refuse. Only Vercel is supported:
  its documentation confirms how the deployment address is printed; the
  others weren't confirmed, so they aren't offered.
- Production needs a passing release check **and** a passing preview check
  of the same commit.
- **G-DEPLOYED** is the one gate that leaves this computer: GET only, only to
  the host the deploy printed (on the provider's domain or the one you
  confirmed), no cookies, credentials or body, redirects only within that
  host, at most 20 requests. A failed production check offers a rollback,
  which you approve.
- Kriya **never runs**: migrations against a hosted database, production
  environment or secret changes, DNS or domain changes, merges or force
  pushes, deleting deployments. With `--deploy` on, the agent's shell refuses
  them and the command is written down for you (the receipt's "For you to
  run").
- `kriya doctor --gates` shows which gates work on this computer and runs the
  self-tests of those that need nothing installed. `kriya report` writes a
  redacted bundle (versions, that matrix, this project's receipts) for you to
  attach to a bug report; nothing is sent.

### Proof receipts (`kriya receipt`)

`kriya receipt make` (and a draft pull request, with repository tools on)
writes `~/.kriya/receipts/<project>/<session>.json` and `.md`: each step's
verdict, attempts, role, model tiers and gate results, the cartridge versions
and the commit, copied from Kriya's own records. It holds no file contents,
prompts, commands, check output, paths or secrets. A hash chain over the check
runs makes a later edit visible: `kriya receipt verify <file>` names the first
run that changed. It says "checked on this computer": evidence of what Kriya
checked, not a guarantee.

### MCP servers (`--mcp`)

Only servers in Kriya's owner-reviewed registry, only those you enabled in
Kriya, and only those that need no sign-in (DeepSeek Harness's MCP client
can't hold a sign-in, and a token kept on Kriya's server never reaches your
device). Each tool is used only if its full definition still matches what the
owner pinned; a changed tool isn't offered. A tool that isn't read-only asks
you before every call. No credential is sent to a server, the address must be
https, and what a server returns is marked untrusted.

### The local stack (`kriya stack use`)

Gates that need a running app or database use only what you confirm, once
per project:

```bash
kriya stack use --app http://localhost:3000 --db postgresql://postgres:postgres@127.0.0.1:54322/postgres
```

- Kept in `~/.kriya/stack.json`. Kriya never starts Docker or a database
  itself; you start your stack (for Supabase, `supabase start`).
- Both addresses must name this machine: `localhost`, a `.localhost` name,
  `127.x.x.x` or `::1`, with no user name or password in them. Gates never
  follow a redirect, so an app can't send them elsewhere.
- If your project's own environment names a database (`DATABASE_URL` and
  similar) that **isn't** local, every stack gate refuses with "this
  project's database URL isn't local": a gate never runs migrations or
  probes against a hosted database.
- `kriya stack` shows it; `kriya stack forget` removes it.

### Role cartridges and their updates

Cartridges are guidance text only, served by Kriya: no command, URL, tool,
mode, approval or limit can be in one. Kriya's owner may approve an updated
cartridge after an automated lint and a benchmark run on their own machine;
with Kriya's overlay off (the default) nothing approved reaches you until it
ships in a release. `KRIYA_BENCH` and `KRIYA_CARTRIDGE_FILE` are for that
benchmark only: without `KRIYA_BENCH=on` the file is never read.

## What it can do on this machine

The agent reads and changes files and runs commands under the mode you
start it in (`kriya --mode <mode>`, `kriya run --mode <mode>`; in the Web
UI, the Permissions control or `/permission`). Every mode is one of
DeepSeek Harness's sandbox modes plus one approval policy, set by Kriya's
bundle; the shell's own variables can't change it.

| Mode | Sandbox | Approvals | What it means |
| --- | --- | --- | --- |
| `ask` (default) | this folder | ask | Writes inside the folder you opened; anything beyond it needs your answer first |
| `auto` | this folder | never | Works inside the folder without asking; anything that would need your answer is refused, never allowed |
| `read` | read-only | never | Reads and answers; changes no file |
| `plan` (`kriya run` only) | read-only | never | Writes a step-by-step plan and changes no file. In the Web UI, type `/plan` |
| `full` | none | never | Runs commands and changes files anywhere you can, without asking. Kriya prints a warning each time |

What the sandbox covers, so you can choose well:

- It governs **file changes**. Network access and which programs run aren't
  limited by it, in any mode.
- "This folder" also includes the platform's temporary areas, which
  DeepSeek Harness leaves writable on purpose.
- `DSH_PERMISSION_MODE` from your environment is no longer read; the mode
  comes only from `--mode` (default `ask`).

Read what it asks to run before you approve it. You can answer in the
terminal, the Web UI or your editor, or in Kriya on your phone: the first
answer wins and the other is withdrawn. With no answer from either (Kriya
unreachable, the request expired), the action is refused.

## Skills you add

A skill you link (`kriya skills link`) or keep in a project's `.dsh/skills`
or `.agents/skills` is instructions the agent follows, like a prompt you
wrote. It can't add a tool or skip an approval, and your mode still applies,
but it can ask the agent to run its scripts or commands. Link skills only
from sources you trust, and read new ones first. The Skills page in the
browser saves only skills you own (in `~/.kriya/skills`, `~/.agents/skills`
or the project) and only through the browser you signed in with: its routes
sit behind DeepSeek Harness's sign-in cookie and its same-origin checks. Their names and descriptions
go to the model with every request.

## What leaves this machine

- **Model calls.** Your prompts, the files and command output the agent
  reads, and its replies go to Kriya's model gateway, which forwards them to
  Kriya's model provider. Kriya's servers keep each call's usage and cost,
  not its content.
- **Approval requests.** The tool's name, a summary and its arguments, with
  values whose names look secret (passwords, tokens, API keys, cookies,
  cards…) replaced by `[redacted]` before they're sent; Kriya redacts again.
- **The session mirror**, only if you turn it on for this device in Kriya
  (Account → Devices); it's off by default.
  - *Summary*: each turn's answer and each tool's name, status and time.
  - *Full*: also each tool's arguments (secret-looking names hidden, as
    above) and up to 4 KB of its output, **which is not redacted**: a
    command that prints a secret sends it. Use Summary in projects that
    hold secrets.
  - Turns wait in `~/.kriya/mirror-queue.json` (readable only by you) while
    Kriya is unreachable. Kriya's cloud agents treat mirrored text as
    outside content, not as your instructions.
- **Step outcome counts**, only after you run `kriya share on` (off by
  default; `kriya share off` stops it and drops counts not yet sent), and
  only with the session mirror on: per role cartridge version, how many
  steps were verified, blocked or not checked. Numbers only: no text,
  names, files or paths. They wait in `~/.kriya/outcomes-pending.json` and
  go with mirrored turns, only to a Kriya that says it takes them.
- **Memory.** Notes the agent saves with `kriya_memory_save` stay
  **unconfirmed** until you confirm them in Kriya (Inbox → Memories to
  review), and Kriya refuses values such as card numbers.
- **`kriya handoff`** uploads the repository's uncommitted changes,
  **including untracked files** (files in `.gitignore` are left out), to
  your Kriya account. Make sure `.env` files and other secrets are ignored
  by git before you hand off. `kriya pull` applies a workspace's changes on
  a new branch `kriya/pull-<id>` and never touches your own branch.
- **`kriya serve [folder]`** lets your Kriya agents' cloud tasks run
  commands and change files **on this machine, as you, with your network**:
  there is no sandbox, firewall or registry-only network here. Each task
  works in a new subfolder `<folder>/<workspace id>-<generation>` (never in
  files already there), and Kriya deletes that subfolder when it closes the
  workspace; a command can still reach anything your account can. It runs
  only while `kriya serve` does (Ctrl-C stops it) and only when your Kriya
  has the device world turned on. Signing the device out in Kriya (Account →
  Devices) disconnects it within minutes.

### Edits from Kriya

Off unless you turn on **Allow editing from Kriya** in Remote Control or start
`kriya daemon --allow-edit`, with editing on. An agent in Kriya can then ask this
computer for one edit at a time, in a folder you offered, after you approve that exact
job. Your footage and project stay here. The job reports its stage, percent, which
checks passed and a reason code, never a file name or a transcript. One small preview
of its own output goes straight to Kriya's storage, if your plan keeps previews, so you
can watch it on your phone. Whether the checks passed is what this computer says; Kriya
can only check the preview file itself.

When a choice is really yours, your phone can show it: which of two files you meant, or
which of two takes, with a few seconds of each as small clips. Each has a default, so a
question nobody answers never stops an edit. Notes you send from your phone come back here
as requests in your own words, checked like any other edit.

`kriya edit watch <folder>` is off until you run it, for that folder only. When a new
recording settles, Kriya hears its name and how long it is, and nothing else. Nothing runs
until you tap its card. `kriya edit unwatch <folder>` stops it.

Kriya notices how you edit, on this computer, in `~/.kriya/edit/taste.json`: the caption look
and the zoom you keep choosing across projects. Nothing changes until you say yes, in the
Studio or on a "Remember this?" card, which carries that one sentence and nothing else. Every
rule is listed on the Studio's home page, and you can remove it there.

## What Kriya Harness keeps on this machine

- `~/.kriya/device.json`: this device's sign-in token, readable only by your
  user account. Anyone who can read it can use your Kriya Harness allowance
  until you sign out (`kriya logout`) or revoke the device in Kriya under
  Account → Devices.
- `~/.kriya/profiles/`: DeepSeek Harness profiles and their session history.
- With Harness 2.0 features on: `~/.kriya/stack.json` (your local stack),
  `~/.kriya/progress/<project>/milestones.json` (the milestone ledger),
  `~/.kriya/evidence/` (what the gates saw), `~/.kriya/share.json` and
  `~/.kriya/outcomes-pending.json` (sharing and its counts). All outside
  your projects.

The token is passed to DeepSeek Harness as `KRIYA_DEVICE_TOKEN`. DeepSeek
Harness removes variables with `TOKEN` in their name from every command the
agent runs, so commands can't read it from the environment. The agent's file
tools may still be able to read `~/.kriya/device.json` if you approve
reading outside the project folder.

## The Web UI and editors

- `kriya` serves its Web UI only on `127.0.0.1`, behind its own session
  link; it never offers a way to bind to another address.
- `kriya acp` talks to your editor over stdin/stdout. The editor is trusted
  as its controller: MCP servers your editor declares for a session are
  started with the commands and environment it gives.

## Reporting

Report a security problem to the Kriya team privately, not in a public
issue.
