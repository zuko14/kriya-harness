// The workspace folder chooser. DSH's adaptive row (dsh-host-directory-picker-auto)
// is replaced by this one, which decides the same way and mounts the same
// packages, with one change on macOS: the native panel opens in a useful
// folder. DSH's panel sets no directoryURL, so macOS opens wherever the last
// panel was (often Downloads), and ~/Developer is in no sidebar: people
// couldn't find their projects (owner report, 2026-11-24).

import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import {
  BACKEND_PACKAGES,
  canExecute,
  hasLinuxChooserBinary,
  resolveDirectoryPickerBackend,
  SURFACE_PACKAGES,
} from "@deepseek-ai/dsh-host-directory-picker-auto"
import { launchEnvironmentOf, launchedThroughSsh } from "@deepseek-ai/dsh-launch-environment"

export const name = "kriya-directory-picker"
export const inject = ["webServer", "connection", "loader"]

export const MAC_BACKEND = "@kriya-ai/harness-directory-picker/native"

/** The packages to mount: DSH's, but Kriya's native backend on macOS */
export function packagesFor(kind, platform) {
  const backend = kind === "native" && platform === "darwin" ? MAC_BACKEND : BACKEND_PACKAGES[kind]
  return [backend, SURFACE_PACKAGES[kind]]
}

/** Where the panel opens: next to the last folder picked, else ~/Developer, else home */
export function startFolder(last, home = homedir(), exists = existsSync) {
  if (last && exists(dirname(last))) return dirname(last)
  const developer = join(home, "Developer")
  return exists(developer) ? developer : home
}

export async function apply(ctx) {
  const kind = resolveDirectoryPickerBackend({
    bindHost: ctx.webServer.host,
    allowsRemoteAuthorities: ctx.connection.allowsRemoteAuthorities,
    platform: process.platform,
    ssh: launchedThroughSsh(launchEnvironmentOf(ctx)),
    env: process.env,
    linuxChooser: hasLinuxChooserBinary(process.env.PATH, canExecute),
  })
  // As dsh-host-directory-picker-auto mounts its pair, so the client surface is found the same way
  await ctx.effect(async () => {
    const ids = []
    const unmount = async () => {
      for (const id of [...ids].reverse()) {
        const entry = ctx.loader.store[id]
        if (entry === undefined) continue
        const disposal = entry.fiber?.dispose()
        ctx.loader.remove(id)
        await disposal
      }
    }
    try {
      for (const pkg of packagesFor(kind, process.platform)) {
        const id = await ctx.loader.create({ name: pkg })
        ids.push(id)
        const entry = ctx.loader.resolve(id)
        if (entry.fiber === undefined) throw new Error(`kriya-directory-picker: failed to load ${pkg}`)
        await entry.fiber.await()
      }
    } catch (cause) {
      await unmount()
      throw cause
    }
    return unmount
  }, "kriya-directory-picker: interaction entries")
}
