// DSH guards write and edit with a file version of dev:ino:size:mtime:ctime.
// ctime moves whenever anything touches a file's metadata: iCloud Drive does
// it for seconds after every save, so in a synced folder an edit fails as
// "changed since it was read" with the content untouched (measured
// 2026-11-06: 3 ctime changes in 5 s in ~/Documents, none in ~/Developer).
// This wraps DSH's freshness decision: when only the ctime moved, the guard
// takes the file's current version. Any change of content still moves
// mtime, size or inode, so a real change is refused exactly as before.

export const name = "kriya-fs-freshness"
export const inject = ["fs"]

const withoutCtime = (version) => String(version).slice(0, String(version).lastIndexOf(":"))

/** An fs/*-intent listener: `next` is DSH's own decision, which it never weakens but for ctime */
export function freshen(fs) {
  return async (target, actor, next) => {
    const intent = await next()
    if (!intent?.version) return intent
    const now = await fs.stat(target)
    return now && withoutCtime(now.version) === withoutCtime(intent.version) ? { ...intent, version: now.version } : intent
  }
}

export function apply(ctx) {
  // First in line, so it wraps fs-observation-policy, which ends the chain
  for (const event of ["fs/edit-intent", "fs/write-intent"]) ctx.on(event, freshen(ctx.fs), true)
}
