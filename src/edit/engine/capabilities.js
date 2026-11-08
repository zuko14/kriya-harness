// What this FFmpeg can do, read from itself: Homebrew's plain build has no `drawtext`
// or `zscale`, so nothing here assumes a filter (EF-37). One table per encoder.

import { EngineFailure, runTool } from "./tool.js"

const secondWord = (text) => new Set(text.split("\n").map((line) => line.trim().split(/\s+/)[1]).filter(Boolean))

export const parseCapabilities = (filters, encoders) => ({ filters: secondWord(filters), encoders: secondWord(encoders) })

export async function readCapabilities(run = runTool) {
  const [filters, encoders] = await Promise.all([run("ffmpeg", ["-hide_banner", "-filters"]), run("ffmpeg", ["-hide_banner", "-encoders"])])
  return parseCapabilities(filters, encoders)
}

export async function toolVersion(run = runTool) {
  return /version (\S+)/.exec(await run("ffmpeg", ["-version"]))?.[1] ?? "unknown"
}

const ENCODERS = {
  h264_videotoolbox: { draft: ["-b:v", "6M"], proxy: [], base: ["-allow_sw", "1", "-pix_fmt", "yuv420p"] },
  libx264: { draft: ["-preset", "veryfast", "-crf", "20"], proxy: ["-preset", "veryfast"], master: ["-preset", "medium", "-crf", "17"], base: ["-pix_fmt", "yuv420p"] },
}

// Hardware for drafts and proxies, quality first for masters (EDIT_ENGINE §8)
const PREFERENCE = { draft: ["h264_videotoolbox", "libx264"], proxy: ["h264_videotoolbox", "libx264"], master: ["libx264", "h264_videotoolbox"] }

/** @param {"draft" | "proxy" | "master"} use */
export function encoderFor({ encoders }, use) {
  const name = PREFERENCE[use].find((candidate) => encoders.has(candidate))
  if (!name) throw new EngineFailure("environment", "missing_feature", "This FFmpeg has no H.264 encoder. Run kriya edit doctor.")
  const { base, ...uses } = ENCODERS[name]
  return ["-c:v", name, ...base, ...(uses[use] ?? uses.draft)]
}
