// Where the Host keeps things (ARCHITECTURE §5): never in a synced folder (EF-28).

import { join } from "node:path"

import { kriyaHome } from "../../paths.js"

export const editHome = (home = kriyaHome()) => join(home, "edit")
export const socketPath = (home) => join(editHome(home), "host.sock")
export const lockPath = (home) => join(editHome(home), "host.lock")
export const portPath = (home) => join(editHome(home), "port")
export const logPath = (home) => join(editHome(home), "host.log")
