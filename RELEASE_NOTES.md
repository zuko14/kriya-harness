# Kriya Harness release notes

## Unreleased: Harness 2.0, "the Autonomous Workforce" (beta)

Built on DeepSeek Harness. Everything below is **off by default**: with none
of it turned on, Kriya Harness behaves exactly as 0.2.5 does (prompts, tools,
plans, checks and mirrored turns byte for byte; tested). Turn a part on for
`kriya run` with its flag, or for any way of starting Kriya Harness with its
variable set to `on`. All of it but grounding needs the loop. What each part can touch is
in [SAFETY.md](SAFETY.md).

### How it works

The session's agent plans the work as before (at most 7 steps, at most 4
attempts each). Each step is built by a fresh builder and passes only on the
exit code of the check you confirmed. Harness 2.0 adds four things around that
loop, each one optional:

- **Role cartridges** (`--cartridges`, `KRIYA_CARTRIDGES`). Kriya serves one
  short guidance text per discipline: frontend, designer, backend, full
  stack, mobile, game, DevOps, cloud, systems, data, ML, security, QA, SDET
  and database. Code picks one per step (the step's role, then its files,
  then its words) and puts it first in the builder's prompt. A cartridge is
  guidance only: no command, URL, tool, mode or limit can be in one.
- **Orchestra** (`--orchestra`, `KRIYA_ORCHESTRA`). Builders run on the
  cheaper level Kriya's owner chose; the stronger level takes over after a
  set number of failed attempts or when a builder is stuck, inside the same
  4 attempts. A builder can ask the stronger level one focused question
  (`kriya_advise`, at most twice per attempt); the advisor reads and changes
  nothing.
- **Gates** (`--gates`, `KRIYA_GATES`). After your check passes, fixed code
  runs the gates the step's role calls for: contracts, banned patterns,
  secrets, flakiness, acceptance tracing, rendered pages and accessibility,
  migrations and row-level security, API contract and bad input, tenant
  isolation, Semgrep with your own rules, data pipelines, evals, sanitizers,
  infrastructure and simulators. Live gates use only the app and database you
  confirm with `kriya stack use`, on this machine. A gate that can't run says
  **not checked**; it never passes by default. Roles name the contracts they
  own under `.kriya/contracts/`, and a step that changes a contract it
  doesn't own fails.
- **Critic** (`--critic`, `KRIYA_CRITIC`). After every gate passes, a
  read-only reviewer on the stronger level may ask for one polish attempt;
  the polish is kept only if every check and gate still passes.
- **Milestones** (`--milestones`, `KRIYA_MILESTONES`). For work too long for
  one plan: `kriya_milestones` records up to 12 milestones, each planned
  with `kriya_plan` once the one before it is done, done only when every
  step of its plan passed your check. The ledger is in `~/.kriya/progress/`,
  outside your project; a new session is told where the work stands.
  Replacing open milestones needs your own click.

- **Grounding** (`--grounding`, `KRIYA_GROUNDING`). Three read-only tools
  answer facts about the packages your project has installed, exact for
  the installed version: `api_lookup` (a signature and its doc comment,
  from TypeScript type definitions, `@types` or Python stubs),
  `api_changes` (the package's own changelog since the version your
  project declares) and `api_version` (declared, locked, installed).
  Nothing is imported or run, nothing is fetched, and nothing outside the
  project is read. It doesn't need the loop.

- **Repository tools** (`--repo-tools`, `KRIYA_REPO_TOOLS`). Typed `git` and
  `gh` tools through your own sign-in: status, diff, log, pull requests,
  checks, failing CI lines and issues to read (marked untrusted); a
  `kriya/` branch, a commit of this session's files, a push and a draft pull
  request, each only after you approve it. Never a merge, a force push or the
  default branch; G-SECRETS checks every commit before a push. Kriya watches a
  draft's checks and offers a fix step when one fails.
- **MCP** (`--mcp`, `KRIYA_MCP`). Tools from servers in Kriya's owner-reviewed
  registry that need no sign-in, each pinned to the definition the owner
  reviewed; anything not read-only asks you first.

- **Proof receipts** (`kriya receipt make`, `kriya receipt verify <file>`).
  What Kriya checked by code on this computer (verdicts, attempts, roles,
  tiers, gates, cartridge versions), copied from its own records, with a
  hash chain that shows any later edit. A draft pull request's body starts
  with it. Evidence, not a guarantee.

- **Releases and deploys** (`--deploy`, `KRIYA_DEPLOY`; `kriya release use`).
  G-RELEASE checks a production build locally; preview and production deploys
  run Vercel's CLI after your approval; production needs a passing release
  check and preview check of the same commit; G-DEPLOYED checks the deployed
  address (GET only, its host only, ≤ 20 requests) and offers a rollback.
  Hosted-database migrations, production secrets, DNS and merges stay yours.
- **`kriya doctor --gates`** and **`kriya report`**: which gates work here, and a
  redacted bundle for bug reports.

### New commands

- `kriya stack use --app <url> --db <url>`, `kriya stack`, `kriya stack
  forget`: the local app and database the gates may use. Loopback only; a
  project whose own environment names a hosted database makes every stack
  gate refuse.
- `kriya gates use <data|eval|san|iac|sim|sim-headless> "<command>"`,
  `kriya gates`, `kriya gates forget <gate>`: the commands the command gates
  run, confirmed by you; `kriya eval baseline confirm` records G-EVAL's
  baseline.
- `kriya share on|off|status`: off by default. On, Kriya gets counts of
  verified, blocked and not-checked steps per cartridge version, with your
  mirrored turns, so Kriya's owner can tell whether a new cartridge helps.
  Counts only.

### How cartridges improve

Kriya's owner can list sources (release notes, standards, advisories). Kriya
reads them, keeps a finding only when its quote is found word for word twice
an hour apart, and may draft a cartridge change. Code lints every draft (no
URL, shell, tool name, credential word or protected path; small changes
only). The owner benchmarks it **on their own machine**, against hidden
graders and safety probes, and approves it by hand; `gate()` decides the
verdict from paired runs, never a model. Approved versions reach devices only
if the owner turns the overlay on, first to a canary share of devices, with
one-click rollback. Nothing changes on your device by itself.

### Compatibility

- Server first: a Kriya without Harness 2.0 simply doesn't serve cartridges
  or the orchestra levels, and the client doesn't send outcome counts to a
  Kriya that doesn't advertise them.
- `contract/contract.json` is Kriya's exported contract; its sha256 is in
  `contract/SOURCE.md`.
- DeepSeek Harness is used through its documented seams only, never edited
  (`npm run check:seams`).
