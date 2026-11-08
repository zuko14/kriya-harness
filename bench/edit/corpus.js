// What must be true before a paid run (EVALUATION_PLAN §2, §3, §6, §9). Plain checks on the
// owner's files, so a run can't start on scraped footage, without a pass list that can fail,
// or with its method still open.

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

const GROUPS = { talking_head: 6, long_to_short: 4, long_form: 3, podcast: 2, tutorial: 2, montage: 2, ad: 3, explainer: 2 }

/**
 * @param {{ tasks: { id: string, group: string, assets: { path: string, source: string, release?: string }[], list: object, checked?: { oracle: boolean, empty: boolean, lazy: boolean } }[] }} corpus
 * @param {{ full?: boolean }} [options] full: the §3 table's size, not a dry run's
 * @returns {string[]} every problem; empty means it may run
 */
export function checkCorpus(corpus, { full = false } = {}) {
  const problems = []
  const tasks = corpus?.tasks ?? []
  if (!tasks.length) problems.push("No tasks.")
  for (const task of tasks) {
    if (!Object.hasOwn(GROUPS, task.group)) problems.push(`${task.id}: unknown group ${task.group}`)
    if (!task.assets?.length) problems.push(`${task.id}: no footage`)
    for (const asset of task.assets ?? []) {
      if (!["own", "released"].includes(asset.source)) problems.push(`${task.id}: ${asset.path} is neither shot by the owner nor released`)
      if (asset.source === "released" && !asset.release) problems.push(`${task.id}: ${asset.path} has no signed release on file`)
      if (/^[a-z]+:\/\//i.test(asset.path ?? "")) problems.push(`${task.id}: ${asset.path} is a link: no scraped or downloaded footage`)
    }
    // §3: an oracle edit passes, an empty one fails, a lazy one fails, or the list proves nothing
    const c = task.checked
    if (!c || c.oracle !== true || c.empty !== false || c.lazy !== false) problems.push(`${task.id}: its pass list hasn't been shown to fail an empty and a lazy edit and to pass an oracle`)
  }
  if (full) for (const [group, want] of Object.entries(GROUPS)) {
    const have = tasks.filter((t) => t.group === group).length
    if (have < want) problems.push(`${group}: ${have} of ${want} tasks`)
  }
  return problems
}

/** §6's pre-registration: tasks, arms and thresholds frozen, by a hash recorded in status.md first. */
export function freezeHash({ tasks, arms, thresholds, raters }) {
  if (!tasks?.length || !arms?.length || !thresholds || !raters) throw new Error("Pre-registration needs the tasks, arms, thresholds and raters.")
  return createHash("sha256").update(JSON.stringify({ tasks, arms, thresholds, raters })).digest("hex")
}

/**
 * EDD-35: no paid call without the owner's go-ahead for this run, in writing, with its limit.
 * @param {string | undefined} file a JSON file: { approvedBy, words, date, maxSpendMicroUsd, scope }
 */
export function readGoAhead(file) {
  if (!file) throw new Error("A paid run needs the owner's go-ahead file (EDD-35). Nothing was run.")
  const go = JSON.parse(readFileSync(file, "utf8"))
  if (go.approvedBy !== "owner" || typeof go.words !== "string" || !go.words.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(go.date ?? "")) throw new Error("That go-ahead doesn't record the owner's words and the date.")
  if (!Number.isSafeInteger(go.maxSpendMicroUsd) || go.maxSpendMicroUsd <= 0) throw new Error("That go-ahead has no spending limit.")
  return go
}
