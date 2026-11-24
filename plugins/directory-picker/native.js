// macOS native backend: DSH's own panel (pickNativeDirectory), told where to
// open. Its script reads only argv[0] (the prompt); one line after the
// prompt line sets the panel's directoryURL from argv[1], passed as an
// argument, never as source. If a DSH update moves that line, the panel
// runs exactly as DSH ships it.

import { DirectoryPicker } from "@deepseek-ai/dsh-host-directory-picker"
import { pickNativeDirectory } from "@deepseek-ai/dsh-host-directory-picker-native"
import { runNativeCommand } from "@deepseek-ai/dsh-native-command"
import { startFolder } from "./index.js"

export const name = "kriya-directory-picker-native"

const MARKER = "panel.message = argv[0];"
const OPEN_AT = " if (argv[1]) panel.directoryURL = $.NSURL.fileURLWithPathIsDirectory(argv[1], true);"

/** The osascript runner with the start folder added; anything else passes unchanged */
export function withStart(run, folder) {
  return (command, args, signal, mode) => {
    const at = args.findIndex((arg) => typeof arg === "string" && arg.includes(MARKER))
    if (command !== "osascript" || at < 0 || !folder) return run(command, args, signal, mode)
    const next = [...args]
    next[at] = next[at].replace(MARKER, MARKER + OPEN_AT)
    return run(command, [...next, folder], signal, mode)
  }
}

export default class KriyaNativeDirectoryPicker extends DirectoryPicker {
  last = null
  nativeCapability = {
    kind: "native",
    pick: async (signal) => {
      const picked = await pickNativeDirectory(signal, { run: withStart(runNativeCommand, startFolder(this.last)) })
      if (picked) this.last = picked
      return picked
    },
  }

  capability() {
    return this.nativeCapability
  }
}
