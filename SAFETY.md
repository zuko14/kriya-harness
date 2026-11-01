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

## What it can do on this machine

The agent reads and changes files and runs commands under DeepSeek Harness's
permission settings. Every Kriya profile (`kriya`, `kriya run`, `kriya acp`)
keeps DeepSeek Harness's defaults:

| Setting | Default | Meaning |
| --- | --- | --- |
| Sandbox | `workspace-write` | Commands run in DeepSeek Harness's sandbox (macOS and Linux) and may write only inside the folder you opened |
| Approvals | `ask` | Anything outside that needs your answer before it runs |

The presets are `read-only`, `workspace-write` and `danger-full-access`. The
last turns approvals off (`never`). DeepSeek Harness reads
`DSH_PERMISSION_MODE` from your environment; **don't set it to
`danger-full-access`** unless the folder is disposable.

Read what it asks to run before you approve it. You can answer in the
terminal, the Web UI or your editor, or in Kriya on your phone: the first
answer wins and the other is withdrawn. With no answer from either (Kriya
unreachable, the request expired), the action is refused.

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
- **Memory.** Notes the agent saves with `kriya_memory_save` stay
  **unconfirmed** until you confirm them in Kriya (Inbox → Memories to
  review), and Kriya refuses values such as card numbers.
- **`kriya handoff`** uploads the repository's uncommitted changes,
  **including untracked files** (files in `.gitignore` are left out), to
  your Kriya account. Make sure `.env` files and other secrets are ignored
  by git before you hand off. `kriya pull` applies a workspace's changes on
  a new branch `kriya/pull-<id>` and never touches your own branch.

## What Kriya Harness keeps on this machine

- `~/.kriya/device.json`: this device's sign-in token, readable only by your
  user account. Anyone who can read it can use your Kriya Harness allowance
  until you sign out (`kriya logout`) or revoke the device in Kriya under
  Account → Devices.
- `~/.kriya/profiles/`: DeepSeek Harness profiles and their session history.

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
