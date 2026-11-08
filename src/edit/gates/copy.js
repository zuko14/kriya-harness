// QG-10 Copy (QUALITY_GATES §2, ED10): the text as rendered, read back by OCR, against
// the text the plan meant, and the names and numbers in it against what was said.
// macOS uses Vision through a small helper compiled once; other systems say so.

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { scriptOf } from "../engine/captions.js"

const HELPER = join(dirname(fileURLToPath(import.meta.url)), "text.swift")
const FLICKS = 705_600_000

/** The compiled reader's path, building it on first use. @returns {Promise<{ path?: string, missing?: string }>} */
export async function ocrHelper(binDir, run, platform = process.platform) {
  if (platform !== "darwin") return { missing: "Reading rendered text on this system needs the Media Runtime's OCR, which isn't in it yet." }
  const source = readFileSync(HELPER)
  const path = join(binDir, `ocr-${createHash("sha256").update(source).digest("hex").slice(0, 12)}`)
  if (existsSync(path)) return { path }
  mkdirSync(binDir, { recursive: true })
  try {
    await run("swiftc", ["-O", HELPER, "-o", `${path}.${process.pid}.part`], { timeoutMs: 300_000 })
    renameSync(`${path}.${process.pid}.part`, path)
  } catch {
    return { missing: "Reading rendered text needs Apple's command line tools (xcode-select --install)." }
  }
  return { path }
}

// Below this, the reader isn't sure of a line (Vision read a highlighted "and" as "anda" at 0.5, found in ED10)
export const UNSURE = 0.8

/** The reader's lines → per image name, the text and the words it wasn't sure of. */
export function readOcr(text) {
  const out = new Map()
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    const { image, lines } = JSON.parse(line)
    out.set(image, { text: lines.map((l) => l.text).join(" "), unsure: lines.filter((l) => l.c < UNSURE).flatMap((l) => normalise(l.text).split(" ")).filter(Boolean) })
  }
  return out
}

/** One edit apart, or the same. */
function nearly(a, b) {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > 1) return false
  return similarity(a, b) >= 1 - 1 / Math.max(a.length, b.length) - 1e-9
}

/** Letters and digits, lower case, one space between words: what both sides are compared as. */
export const normalise = (text) => String(text).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()

export function similarity(a, b) {
  const x = normalise(a)
  const y = normalise(b)
  if (!x.length && !y.length) return 1
  const d = Array.from({ length: y.length + 1 }, (_, j) => j)
  for (let i = 1; i <= x.length; i++) {
    let prev = d[0]
    d[0] = i
    for (let j = 1; j <= y.length; j++) {
      const keep = d[j]
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (x[i - 1] === y[j - 1] ? 0 : 1))
      prev = keep
    }
  }
  return 1 - d[y.length] / Math.max(x.length, y.length)
}

/** What a tile meant to show. */
export function intendedText(tile) {
  if (tile.kind === "caption") return tile.node.text ?? tile.node.words.map((w) => w.text).join(" ")
  return [tile.node.variables?.text, tile.node.variables?.subtitle].filter(Boolean).join(" ")
}

// A name or a number: capitalised after the first word, or with a digit in it
const isNameOrNumber = (text, i) => /\d/.test(text) || (i > 0 && /^\p{Lu}/u.test(text))

/**
 * @param {{ tile: object, seen: string, unsure?: string[] }[]} read unsure: words from lines the reader wasn't sure of
 * @returns {{ failures: object[], numbers: object, unread: object[] }}
 */
export function judgeCopy(read, { copySimilarity }) {
  const failures = []
  const unread = []
  let worst = 1
  for (const { tile, seen, unsure = [] } of read) {
    const meant = intendedText(tile)
    if (scriptOf(meant) !== "latin") {
      unread.push({ tile: tile.key, script: scriptOf(meant) })
      continue
    }
    const score = similarity(meant, seen ?? "")
    worst = Math.min(worst, score)
    // Every word meant must be on screen as itself: a one-letter change in a name passes a similarity (found in ED10)
    const shownWords = new Set(normalise(seen ?? "").split(" "))
    // Where the reader wasn't sure, one letter off is the reader's slip; where it was sure, it is the screen
    const lost = normalise(meant).split(" ").filter((w) => w && !shownWords.has(w) && !unsure.some((u) => nearly(u, w)))
    if (score < copySimilarity || lost.length) failures.push({ kind: "copy_mismatch", t: tile.at, seconds: Math.round((tile.at / FLICKS) * 100) / 100, meant, seen: seen ?? "", similarity: Math.round(score * 100) / 100, ...(lost.length ? { missing: lost } : {}) })
    // What was said: a caption's names and numbers must be on screen as they were spoken
    if (tile.kind === "caption") {
      const shown = ` ${normalise(seen ?? "")} `
      for (const [i, word] of tile.node.words.entries()) {
        if (!isNameOrNumber(word.text, i)) continue
        const said = normalise(word.text)
        if (said && !shown.includes(` ${said} `)) failures.push({ kind: "name_mismatch", t: tile.at + word.at, seconds: Math.round(((tile.at + word.at) / FLICKS) * 100) / 100, said: word.text, seen: seen ?? "" })
      }
    }
  }
  return { failures, unread, numbers: { texts: read.length, worstSimilarity: Math.round(worst * 100) / 100, needed: copySimilarity, unread: unread.length } }
}
