// The bin's list (ASSEMBLY_AND_INTENT §2): search, sort, groups and which rows are drawn.
// Pure, so it's tested without a browser. File names and labels are untrusted text: the
// caller only ever sets them as textContent.

export const fileName = (asset) => asset.path.split(/[\\/]/).at(-1)
export const nameOf = (asset) => asset.label ?? fileName(asset)

const fold = (text) => String(text ?? "").toLocaleLowerCase()

/**
 * The assets whose label, file name or spoken words hold every word asked for.
 * Words are read as the person corrected them and as first heard, so a fixed word is found
 * either way: the index's own text search (words_fts) holds only what was heard (EH-77).
 * @param {{ id: string, path: string, label?: string }[]} assets
 * @param {{ asset: string, text: string, heard?: string }[]} words from GET /projects/{id}/index
 */
export function searchBin(assets, words, query) {
  const terms = fold(query).split(/\s+/).filter(Boolean)
  if (!terms.length) return assets
  const spoken = new Map()
  for (const word of words ?? []) spoken.set(word.asset, `${spoken.get(word.asset) ?? ""} ${fold(word.text)} ${fold(word.heard)}`)
  return assets.filter((asset) => {
    const all = `${fold(asset.label)} ${fold(fileName(asset))} ${spoken.get(asset.id) ?? ""}`
    return terms.every((term) => all.includes(term))
  })
}

export const SORTS = { added: "Order added", recorded: "Date recorded", length: "Length", name: "Name" }

/** A sorted copy. "added" is the project's own order, which is also the clip numbers' order. */
export function sortBin(assets, by) {
  const list = [...assets]
  if (by === "recorded") return list.sort((a, b) => (a.recorded ?? "\uffff").localeCompare(b.recorded ?? "\uffff"))
  if (by === "length") return list.sort((a, b) => (b.facts?.duration ?? 0) - (a.facts?.duration ?? 0))
  if (by === "name") return list.sort((a, b) => nameOf(a).localeCompare(nameOf(b), undefined, { numeric: true, sensitivity: "base" }))
  return list
}

export const GROUPS = { none: "No groups", folder: "By folder", day: "By day recorded" }

const folderOf = (asset) => asset.path.split(/[\\/]/).slice(0, -1).join("/") || "Project folder"
const dayOf = (asset) => (asset.recorded ? asset.recorded.slice(0, 10) : "No date")

/** @returns {{ name: string | null, assets: object[] }[]} in the order each group first appears */
export function groupBin(assets, by) {
  if (by !== "folder" && by !== "day") return [{ name: null, assets }]
  const groups = new Map()
  for (const asset of assets) {
    const name = by === "folder" ? folderOf(asset) : dayOf(asset)
    groups.set(name, [...(groups.get(name) ?? []), asset])
  }
  return [...groups].map(([name, list]) => ({ name, assets: list }))
}

// Above this many rows only the ones in view are drawn
export const VIRTUAL_ABOVE = 60

/**
 * The rows to draw for a scrolled list, with a few either side.
 * @param {number[]} heights each row's height, in order
 * @returns {{ start: number, end: number, before: number, after: number }} before, after: the height of what isn't drawn
 */
export function windowOf(heights, scrollTop, viewHeight, extra = 4) {
  let top = 0
  let first = heights.length
  let last = heights.length
  for (const [i, height] of heights.entries()) {
    if (first === heights.length && top + height > scrollTop) first = i
    if (top >= scrollTop + viewHeight) {
      last = i
      break
    }
    top += height
  }
  const start = Math.max(0, first - extra)
  const end = Math.min(heights.length, last + extra)
  const sum = (list) => list.reduce((all, height) => all + height, 0)
  return { start, end, before: sum(heights.slice(0, start)), after: sum(heights.slice(end)) }
}
