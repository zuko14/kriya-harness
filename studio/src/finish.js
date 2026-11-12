// Finish mode: scopes over the monitor's own pixels (histogram and luma waveform,
// on the CPU here; GPU compute comes with the WebGPU compositor), and export.
// Export starts the Host's render jobs; progress arrives as server-sent events.
// Handoff writes the cut for another editor (OTIO, FCPXML, EDL, SRT) beside the project.

import { api, clear, h } from "./dom.js"
import { timecode } from "./time.js"

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b

/** Scopes from an ImageData: 256-bin luma histogram and a waveform of luma by column. */
export function scopesOf(image, columns = 128) {
  const histogram = new Uint32Array(256)
  const waveform = Array.from({ length: columns }, () => new Uint32Array(64))
  const { data, width, height } = image
  const step = Math.max(1, Math.floor((width * height) / 60_000))
  for (let i = 0, p = 0; p < width * height; p += step, i = p * 4) {
    const y = Math.min(255, Math.round(luma(data[i], data[i + 1], data[i + 2])))
    histogram[y]++
    waveform[Math.min(columns - 1, Math.floor(((p % width) / width) * columns))][y >> 2]++
  }
  return { histogram, waveform }
}

/**
 * @param {{ root: HTMLElement, pixels: () => ImageData | null, project: () => object }} options
 */
const VERDICT = { delivered: "Checked", delivered_with_notes: "Checked, with notes", blocked: "Needs you: a check failed", not_checked: "Not checked" }

// The gates' names (QUALITY_GATES §2), for the scorecard: the Host sends ids, statuses and its own messages
export const GATE_NAMES = {
  "QG-01": "Playable and to spec",
  "QG-02": "Length",
  "QG-03": "Sync",
  "QG-04": "Round-trip speech",
  "QG-05": "Cut hygiene",
  "QG-06": "Loudness",
  "QG-07": "Picture health",
  "QG-08": "Layout",
  "QG-09": "Legibility",
  "QG-10": "Copy",
  "QG-11": "Motion",
  "QG-12": "Brief",
  "QG-13": "Rights",
  "QG-14": "Blind reviewer",
  "QG-15": "Assembly",
  "QG-16": "Reference fit",
}
const SAID = { passed: "Passed", failed: "Failed", not_checked: "Not checked", not_applicable: "Not applicable" }

/**
 * The scorecard of a finished make, from its own result: each gate as it ran, the ladder's repairs and the
 * Director's watch rounds. Nothing is counted that the make didn't report.
 * @returns {{ summary: string, gates: { id: string, name: string, said: string, status: string, message: string }[], repairs: string[] } | null}
 */
export function scorecardOf(result) {
  if (!result || !Array.isArray(result.gates) || !result.gates.length) return null
  const gates = result.gates.map((g) => ({ id: String(g.id), name: GATE_NAMES[g.id] ?? String(g.id), status: g.status === "failed" && g.severity === "note" ? "note" : String(g.status), said: g.status === "failed" && g.severity === "note" ? "Note" : (SAID[g.status] ?? String(g.status)), message: typeof g.message === "string" ? g.message : "", ...(Number.isFinite(g.at) && g.at >= 0 && g.status === "failed" ? { at: g.at } : {}) }))
  const passed = gates.filter((g) => g.status === "passed").length
  const failed = gates.filter((g) => g.status === "failed").length
  const repairs = [
    ...(result.repairs ?? []).map((a) => `Repair round ${a.round}: ${(a.fixes ?? []).map((f) => f.why ?? f.kind).join("; ") || "no fix"}${a.accepted ? ", kept" : `, not kept${a.reason ? ` (${a.reason})` : ""}`}.`),
    ...(result.watch?.rounds ?? []).map((r) => `Watch round ${r.round}: ${(r.fixes ?? []).join(", ") || "no fix"}${r.kept ? ", kept" : `, not kept${r.reason ? ` (${r.reason})` : ""}`}.`),
  ]
  const rest = gates.length - passed - failed
  return { summary: `${passed} passed, ${failed} failed${rest ? `, ${rest} not checked or not applicable` : ""}`, gates, repairs }
}

/**
 * The final cut (2026-11-09, from use): the real rendered film, captions, look, music and sound
 * included, watched here before downloading. The preview monitor shows only the picture.
 * @param {{ root: HTMLElement, finalRoot: HTMLElement, pixels: () => ImageData | null, project: () => object, onAdjust: () => void }} options
 */
export function createFinish({ root, finalRoot, pixels, project, onAdjust = () => {}, scorecard = false, head = () => null, onShow = () => {} }) {
  const film = h("video", { class: "final-film", controls: true, preload: "metadata", playsinline: true, "aria-label": "The final cut" })
  const filmNote = h("p", { class: "note", role: "status" })
  const filmPick = h("select", { id: "final-pick", class: "field select", "aria-label": "Which film", onchange: () => showFilm() })
  const download = h("a", { class: "btn primary", href: "#", download: "", hidden: true }, "Download")
  let films = []
  const urlOf = (r) => `/projects/${project().id}/renders/${r.job}`
  const when = (at) => (at ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "")
  function showFilm() {
    const chosen = films.find((r) => String(r.job) === filmPick.value) ?? films[0]
    if (!chosen) {
      film.removeAttribute("src")
      film.hidden = true
      download.hidden = true
      filmPick.hidden = true
      filmNote.textContent = "No film yet. Render a draft and the finished cut plays here, captions, look, music and sound included."
      return
    }
    film.hidden = false
    filmPick.hidden = films.length < 2
    const url = urlOf(chosen)
    if (film.getAttribute("src") !== url) film.src = url
    download.hidden = false
    download.href = `${url}?download=1`
    download.setAttribute("download", chosen.name)
    const state = chosen.current ? "This is your edit as it is now." : "Made before your latest changes: render a draft to see them."
    filmNote.textContent = `${state}${chosen.verdict ? ` ${VERDICT[chosen.verdict] ?? chosen.verdict}.` : ""}`
    filmNote.classList.toggle("stale", !chosen.current)
  }
  let asked = 0
  let seenNewest = 0
  async function refreshFilms() {
    // Job events come fast: only the latest answer is shown (found in use: a slower, older one won)
    const mine = ++asked
    const list = (await api("GET", `/projects/${project().id}/renders`)).renders
    if (mine !== asked) return
    const was = filmPick.value
    films = list
    const newest = films[0]?.job ?? 0
    clear(filmPick).append(...films.map((r) => h("option", { value: String(r.job) }, `${r.quality === "draft" ? "Draft" : "Master"} · ${when(r.at)}${r.current ? " · current" : ""} · ${r.name}`)))
    // A newer film comes to the front; otherwise the one the person was watching stays
    filmPick.value = String(newest > seenNewest || !films.some((r) => String(r.job) === was) ? newest : was)
    seenNewest = Math.max(seenNewest, newest)
    showFilm()
  }
  finalRoot.append(
    h(
      "section",
      { class: "panel final", "aria-label": "Final cut" },
      h("h2", {}, "Final cut"),
      film,
      filmNote,
      h("div", { class: "row" }, filmPick, download, h("button", { type: "button", class: "btn", onclick: () => start("draft") }, "Render again"), h("button", { type: "button", class: "btn", onclick: onAdjust }, "Adjust in Edit")),
    ),
  )

  const histogram = h("canvas", { class: "scope", width: 256, height: 100, role: "img", "aria-label": "Luma histogram" })
  const waveform = h("canvas", { class: "scope", width: 256, height: 100, role: "img", "aria-label": "Luma waveform" })
  const jobs = h("ul", { class: "jobs", "aria-live": "polite" })
  const status = h("p", { class: "note", role: "status" })
  const start = async (quality) => {
    status.textContent = ""
    try {
      await api("POST", "/jobs", { project: project().id, quality })
      refresh()
    } catch (error) {
      status.textContent = error.message
    }
  }
  const handoffStatus = h("p", { class: "note", role: "status" })
  const handoffFiles = h("ul", { class: "jobs", "aria-label": "Handoff files" })
  const handoff = async () => {
    handoffStatus.textContent = ""
    clear(handoffFiles)
    try {
      const done = await api("POST", `/projects/${project().id}/export/handoff`)
      const n = done.chapters.length
      const chapters = n ? `, ${n} chapter${n === 1 ? "" : "s"}` : ""
      handoffStatus.textContent = `Written to ${done.folder}, with ${done.media} media file${done.media === 1 ? "" : "s"} linked${chapters}.`
      for (const name of done.files) handoffFiles.append(h("li", {}, h("span", { class: "file" }, name)))
      // What a format can't carry is said, never dropped silently
      for (const item of done.omitted) handoffFiles.append(h("li", {}, h("span", { class: "label-mono" }, item.format), ` ${item.reason}`))
    } catch (error) {
      handoffStatus.textContent = error.message
    }
  }
  // The quality scorecard (editing.livePreview): the latest make's checks and repairs, as it reported them
  const card = scorecard ? h("details", { class: "panel scorecard" }, h("summary", {}, h("span", { class: "score-title" }, "Quality checks"), h("span", { class: "score-sum" }, "No make yet"))) : null
  const cardBody = scorecard ? h("div", { class: "score-body" }) : null
  card?.append(cardBody)
  function showCard(all) {
    if (!card) return
    const made = all.filter((j) => j.project === project().id && j.kind === "make" && j.status === "done").at(-1)
    let result = null
    try {
      result = made ? JSON.parse(made.output) : null
    } catch {}
    const score = scorecardOf(result)
    // A check's moment is a time in the film that make rendered: offered only while the cut is still that one
    const current = result?.head != null && result.head === head()
    card.querySelector(".score-sum").textContent = score ? score.summary : "No make yet"
    clear(cardBody)
    if (!score) return cardBody.append(h("p", { class: "note" }, "Make it in Brief and each check the film went through is listed here."))
    cardBody.append(
      h("ul", { class: "score-gates" }, score.gates.map((g) => h("li", { class: `score-row ${g.status}` }, h("span", { class: "score-id label-mono" }, g.id), h("span", { class: "score-name" }, g.name), h("span", { class: "score-status" }, g.said), g.message ? h("span", { class: "score-msg" }, g.message) : null, current && g.at !== undefined ? h("button", { type: "button", class: "btn small score-show", onclick: () => onShow(g.at) }, `Show ${g.id} at ${timecode(g.at, project().canvas.fps)}`) : null))),
      ...(score.repairs.length ? [h("p", { class: "score-head" }, "Repairs"), h("ul", { class: "score-repairs" }, score.repairs.map((line) => h("li", {}, line)))] : []),
      h("p", { class: "note small" }, "Measured on the rendered master by code, never by a model's say-so."),
    )
  }
  root.append(
    ...(card ? [card] : []),
    h("section", { class: "panel scopes", "aria-label": "Scopes" }, h("h2", {}, "Scopes"), h("div", { class: "scope-row" }, h("figure", {}, histogram, h("figcaption", {}, "Histogram")), h("figure", {}, waveform, h("figcaption", {}, "Waveform"))), h("p", { class: "note" }, "Measured on the preview: 8-bit, from the proxy.")),
    h(
      "section",
      { class: "panel export", "aria-label": "Export" },
      h("h2", {}, "Export"),
      h("div", { class: "row" }, h("button", { type: "button", class: "btn", onclick: () => start("draft") }, "Render a draft"), h("button", { type: "button", class: "btn primary", onclick: () => start("master") }, "Render the master")),
      h("p", { class: "note" }, "Files go to the exports folder beside the project. Sources are never written."),
      status,
      jobs,
    ),
    h(
      "section",
      { class: "panel handoff", "aria-label": "Handoff" },
      h("h2", {}, "Handoff"),
      h("p", { class: "note" }, "For Premiere, Resolve or Final Cut: the cut as OTIO, FCPXML, EDL and SRT, with chapters, and the media linked beside them."),
      h("div", { class: "row" }, h("button", { type: "button", class: "btn", onclick: handoff }, "Export for another editor")),
      handoffStatus,
      handoffFiles,
    ),
  )

  function paint(canvas, columns) {
    const c = canvas.getContext("2d")
    c.clearRect(0, 0, canvas.width, canvas.height)
    c.fillStyle = getComputedStyle(root).getPropertyValue("--scope").trim() || "#6cc0b8"
    columns(c)
  }

  function scopes() {
    const image = pixels()
    if (!image) return
    const { histogram: bins, waveform: wave } = scopesOf(image)
    const top = Math.max(1, ...bins)
    paint(histogram, (c) => bins.forEach((n, i) => c.fillRect(i, 100 - (n / top) * 100, 1, (n / top) * 100)))
    paint(waveform, (c) =>
      wave.forEach((column, x) =>
        column.forEach((n, y) => {
          if (!n) return
          c.globalAlpha = Math.min(1, 0.15 + n / 200)
          c.fillRect(x * 2, 100 - (y / 64) * 100 - 2, 2, 2)
        }),
      ),
    )
  }

  async function refresh() {
    refreshFilms().catch((error) => (filmNote.textContent = error.message))
    const { jobs: all } = await api("GET", "/jobs")
    showCard(all)
    clear(jobs)
    for (const job of all.filter((j) => j.project === project().id && j.kind === "render").reverse().slice(0, 8)) {
      const name = job.output ? job.output.split(/[\\/]/).at(-1) : null
      jobs.append(h("li", {}, h("span", { class: "label-mono" }, job.status), ` ${job.progress}%`, name ? h("span", { class: "file" }, ` ${name}`) : null, job.error ? h("span", { class: "error" }, ` ${job.error}`) : null))
    }
  }

  return { scopes, refresh }
}
