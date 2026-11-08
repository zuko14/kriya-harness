// Finish mode: scopes over the monitor's own pixels (histogram and luma waveform,
// on the CPU here; GPU compute comes with the WebGPU compositor), and export.
// Export starts the Host's render jobs; progress arrives as server-sent events.
// Handoff writes the cut for another editor (OTIO, FCPXML, EDL, SRT) beside the project.

import { api, clear, h } from "./dom.js"

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
export function createFinish({ root, pixels, project }) {
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
  root.append(
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
    const { jobs: all } = await api("GET", "/jobs")
    clear(jobs)
    for (const job of all.filter((j) => j.project === project().id && j.kind === "render").reverse().slice(0, 8)) {
      const name = job.output ? job.output.split(/[\\/]/).at(-1) : null
      jobs.append(h("li", {}, h("span", { class: "label-mono" }, job.status), ` ${job.progress}%`, name ? h("span", { class: "file" }, ` ${name}`) : null, job.error ? h("span", { class: "error" }, ` ${job.error}`) : null))
    }
  }

  return { scopes, refresh }
}
