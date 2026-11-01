# Kriya Harness safety notice (beta)

Kriya Harness is a **beta**. It is built on DeepSeek Harness, which describes
itself as experimental developer-preview software that has not had a
security audit and expects breaking changes. Kriya hasn't changed that: do
not treat Kriya Harness as secure or production-ready.

## What it can do on this machine

- The agent reads and changes files and runs commands, starting in the
  folder you open it in, under DeepSeek Harness's permission settings
  (the Kriya profiles keep its default, `workspace-write`).
- It sends your prompts, the files and command output it reads, and its
  replies to Kriya's model gateway, which forwards them to Kriya's model
  provider. Kriya's servers keep the usage and cost of each call, not its
  content (HD-17).
- The Web UI runs only on `127.0.0.1` and needs its own session link; `kriya`
  never offers a way to bind it to another address.

## What Kriya Harness keeps on this machine

- `~/.kriya/device.json`: this device's sign-in token, readable only by your
  user account. Anyone who can read it can use your Kriya Harness allowance
  until you sign out (`kriya logout`) or revoke the device in Kriya under
  Account → Devices.
- `~/.kriya/profiles/`: DeepSeek Harness profiles and their session history.

The token is passed to DeepSeek Harness as `KRIYA_DEVICE_TOKEN`; DeepSeek
Harness removes variables with `TOKEN` in their name from every command the
agent runs. The agent's file tools may still be able to read files in your
home folder, including `~/.kriya/device.json`, if you allow it.

## Use it safely

- Start it in a folder you can afford to lose, and keep backups or commit
  your work first.
- Read what it asks to run before you approve it.
- Sign out on machines you share.

Report a security problem to the Kriya team, not in a public issue.
