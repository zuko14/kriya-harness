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
