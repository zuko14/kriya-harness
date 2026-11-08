// The Kriya Editing Studio (UX_SPEC): its own app on the Edit Host's loopback origin.
// Home lists projects; a project opens the workspace in one of three modes. The
// monitor, transcript and timeline are made once per project and survive mode
// switches, so changing mode never resets playback.

import { api, clear, h } from "./dom.js"
import { createFinish } from "./finish.js"
import { createMonitor } from "./monitor.js"
import { durationOf, programOf, shotMarks, sourceAt, sourceProgram, pieceAt, timelineAt } from "./program.js"
import { keyAction, timecode, transport } from "./time.js"
import { createTimeline } from "./timeline.js"
import { createTranscript } from "./transcript.js"

const app = document.getElementById("app")
const MODES = ["direct", "edit", "finish"]
const remember = (key, value) => {
  try {
    if (value === undefined) return localStorage.getItem(key)
    localStorage.setItem(key, value)
  } catch {
    return null
  }
}
const back = () => {
  try {
    return sessionStorage.getItem("kriya-edit-back")
  } catch {
    return null
  }
}

function topBar(...middle) {
  const home = back()
  return h("header", { class: "bar" }, home ? h("a", { class: "btn ghost", href: home }, "← Kriya Harness") : h("span", { class: "brand" }, "Kriya"), h("span", { class: "title" }, "Editing Studio"), ...middle)
}

function signedOut(message) {
  clear(app).append(h("main", { class: "center" }, h("h1", {}, "Open the Studio from Kriya"), h("p", {}, message ?? "Click Editing Studio in Kriya Harness, or run kriya edit and open its link.")))
}

/* ───────────────────────────── home ───────────────────────────── */

async function home() {
  let projects
  try {
    ;({ projects } = await api("GET", "/projects"))
  } catch (error) {
    return error.status === 401 ? signedOut() : signedOut(error.message)
  }
  const name = h("input", { id: "new-name", class: "field", required: true, placeholder: "Pricing reel", autocomplete: "off" })
  const folder = h("input", { id: "new-folder", class: "field", required: true, placeholder: "/Users/you/Movies/pricing" })
  const status = h("p", { class: "note", role: "status" })
  const create = h(
    "form",
    {
      class: "panel new",
      onsubmit: async (event) => {
        event.preventDefault()
        try {
          const { id } = await api("POST", "/projects", { name: name.value.trim(), folder: folder.value.trim() })
          location.hash = `#/p/${id}`
        } catch (error) {
          status.textContent = error.message
        }
      },
    },
    h("h2", {}, "New project"),
    h("label", { for: "new-name" }, "Name"),
    name,
    h("label", { for: "new-folder" }, "Folder for the project file (its footage stays where it is)"),
    folder,
    h("button", { class: "btn primary", type: "submit" }, "Create"),
    status,
  )
  // Taste (UX_SPEC §3, DIRECTOR_AND_AGENT §12): what Kriya has noticed, and what's in use.
  // All of it is visible and removable here, on this computer
  const tasteBox = h("section", { class: "panel taste", "aria-label": "Your taste" })
  const showTaste = async (taste) => {
    const { proposed, confirmed } = taste ?? (await api("GET", "/taste"))
    const act = (key, action) => async () => showTaste(await api("POST", `/taste/${encodeURIComponent(key)}/${action}`))
    clear(tasteBox).append(
      h("h2", {}, "Your taste"),
      ...(proposed.length || confirmed.length ? [] : [h("p", { class: "note" }, "Nothing yet. When you make the same choice across projects, Kriya asks here before using it.")]),
      ...proposed.map((rule) => h("div", { class: "taste-row" }, h("p", {}, rule.sentence), h("button", { type: "button", class: "btn primary", onclick: act(rule.key, "confirm") }, "Use it"), h("button", { type: "button", class: "btn", onclick: act(rule.key, "dismiss") }, "No"))),
      ...confirmed.map((rule) => h("div", { class: "taste-row" }, h("p", {}, rule.shown), h("button", { type: "button", class: "btn", "aria-label": `Remove the rule ${rule.shown}`, onclick: act(rule.key, "remove") }, "Remove"))),
    )
  }
  showTaste().catch(() => {})
  clear(app).append(
    topBar(),
    h(
      "main",
      { class: "home" },
      h("h1", {}, "What are we making?"),
      h("section", { class: "panel" }, h("h2", {}, "Projects"), projects.length ? h("ul", { class: "projects" }, projects.map((p) => h("li", {}, h("a", { class: "btn", href: `#/p/${p.id}` }, p.name)))) : h("p", { class: "note" }, "No projects yet.")),
      create,
      tasteBox,
    ),
  )
}

/* ─────────────────────────── workspace ────────────────────────── */

async function workspace(id) {
  let view
  try {
    view = await api("GET", `/projects/${id}`)
  } catch (error) {
    return error.status === 401 ? signedOut() : signedOut(error.message)
  }
  let project = view.project
  let assets = view.assets
  let index = { assets: [], words: [], sentences: [], takes: [], shots: [] }
  let pieces = []
  let timelineData = { picture: [], overlays: [], audio: [], captions: [] }
  let source = null // an asset id when the monitor shows a source instead of the cut
  let mode = MODES.includes(remember("kriya-edit-mode")) ? remember("kriya-edit-mode") : "direct"
  const fps = () => project.canvas.fps

  const time = h("span", { class: "time label-mono", "aria-live": "off" }, "00:00.00")
  const which = h("span", { class: "chip" }, "Preview")
  const canvas = h("canvas", { class: "monitor", role: "img", "aria-label": "Program monitor" })
  const say = h("p", { class: "note", role: "status", "aria-live": "polite" })

  const monitor = createMonitor({
    canvas,
    urlOf: (asset) => `/media/${assets.find((a) => a.id === asset).media}`,
    assetOf: (asset) => assets.find((a) => a.id === asset),
    onTime: (t) => {
      time.textContent = `${timecode(t, fps())} / ${timecode(durationNow(), fps())}`
      timeline.setTime(t)
      strip.setTime(t)
      const piece = pieceAt(currentPieces(), t)
      const at = piece ? sourceAt(piece, t) : null
      const word = at === null ? null : index.words.find((w) => w.asset === piece.asset && at >= w.start && at < w.end)
      transcript.playing(word?.id ?? null)
    },
    onRate: (rate) => {
      play.textContent = rate === 0 ? "Play" : "Pause"
      play.setAttribute("aria-label", rate === 0 ? "Play (Space)" : `Pause (Space), playing at ${rate}×`)
    },
  })
  const currentPieces = () => (source ? sourceProgram(assets.find((a) => a.id === source)) : pieces)
  const durationNow = () => durationOf(currentPieces())

  const transcriptEl = h("div", { class: "transcript", tabindex: "-1" })
  const stripEl = h("div", { class: "strip" })
  const timelineEl = h("div", { class: "timeline" })
  const finishEl = h("div", { class: "finish" })
  const transcript = createTranscript({
    root: transcriptEl,
    onSeek: (word) => {
      const at = timelineAt(pieces, word.asset, word.start)
      if (at !== null) {
        showProgram()
        monitor.seek(at)
      } else showSource(word.asset, word.start)
    },
    onCut: (first, last) => change([{ op: "remove_range", asset: first.asset, from: { word: first.id, edge: "start" }, to: { word: last.id, edge: "end" } }]),
  })
  const timeline = createTimeline({ root: timelineEl, onSeek: (t) => (showProgram(), monitor.seek(t)) })
  const strip = createTimeline({ root: stripEl, compact: true, onSeek: (t) => (showProgram(), monitor.seek(t)) })
  const finish = createFinish({ root: finishEl, pixels: () => monitor.pixels(), project: () => project })

  function showProgram() {
    if (!source) return
    source = null
    which.textContent = "Preview"
    monitor.load(pieces, { fps: fps(), duration: durationOf(pieces), shape: project.canvas })
  }
  function showSource(asset, at) {
    source = asset
    const facts = assets.find((a) => a.id === asset).facts
    which.textContent = "Source"
    monitor.load(sourceProgram(assets.find((a) => a.id === asset)), { fps: facts.fps ?? fps(), duration: facts.duration, shape: { width: facts.width ?? 1920, height: facts.height ?? 1080 } }).then(() => monitor.seek(at))
  }

  async function reload() {
    const [next, plan, found] = await Promise.all([api("GET", `/projects/${id}`), api("GET", `/projects/${id}/plan`), api("GET", `/projects/${id}/index`)])
    project = next.project
    assets = next.assets
    index = found
    timelineData = plan.timeline
    pieces = programOf(plan.timeline)
    const total = durationOf(pieces)
    const marks = shotMarks(pieces, index.shots)
    // Notes from the Review Room, wherever their words are in this cut (ED15)
    const wordsById = new Map((index.words ?? []).map((w) => [w.id, w]))
    const sequence = project.sequences.find((q) => q.id === project.active)
    const pins = (sequence?.markers ?? []).flatMap((m) => {
      const word = m.name.startsWith("Note: ") && m.at?.word ? wordsById.get(m.at.word) : null
      const at = word ? timelineAt(pieces, word.asset, word.start) : null
      return at === null || at === undefined ? [] : [{ at, name: m.name }]
    })
    timeline.load(timelineData, { duration: total, fps: fps(), marks, pins })
    strip.load({ picture: timelineData.picture }, { duration: total, fps: fps(), marks })
    transcript.load(index)
    renderBin()
    if (!source) await monitor.load(pieces, { fps: fps(), duration: total, shape: project.canvas })
    for (const asset of new Set([...timelineData.audio, ...timelineData.picture].map((item) => item.asset))) {
      const media = assets.find((a) => a.id === asset)?.media
      if (media && assets.find((a) => a.id === asset).facts.hasAudio) {
        fetch(`/tiles/${media}?kind=peaks`)
          .then((r) => (r.ok ? r.json() : null))
          .then((peaks) => peaks && (timeline.setPeaks(asset, peaks.levels[0]), strip.setPeaks(asset, peaks.levels[0])))
          .catch(() => {})
      }
    }
  }

  async function change(ops) {
    try {
      const result = await api("PATCH", `/projects/${id}`, { ops })
      say.textContent = result.diagnostics?.length ? result.diagnostics[0].message : ""
    } catch (error) {
      say.textContent = error.value?.diagnostics?.[0]?.message ?? error.message
    }
    await reload()
  }

  /* bin */
  const bin = h("ul", { class: "bin", "aria-label": "Footage" })
  const addPath = h("input", { id: "add-path", class: "field", placeholder: "/path/to/take.mov", autocomplete: "off" })
  function renderBin() {
    clear(bin)
    for (const asset of assets) {
      const status = index.assets.find((a) => a.asset === asset.id)
      const words = status?.layers.find((l) => l.layer === "L2")
      const note = !status ? "Not indexed" : words?.status === "ok" ? "Indexed" : (words?.notice ?? "Indexed, no words")
      bin.append(
        h(
          "li",
          { class: "asset" },
          h("button", { type: "button", class: "btn", onclick: () => showSource(asset.id, 0) }, `${asset.path.split(/[\\/]/).at(-1)} · ${asset.kind}`),
          h("span", { class: "note" }, note),
          h("button", { type: "button", class: "btn", onclick: async () => (await api("POST", `/projects/${id}/index`, { asset: asset.id }), (say.textContent = "Reading your footage. You can start working now.")) }, "Index"),
          h("button", { type: "button", class: "btn", onclick: () => change([{ op: "keep_range", asset: asset.id, from: 0, to: asset.facts.duration }]) }, "Add to cut"),
        ),
      )
    }
  }
  const binPanel = h(
    "section",
    { class: "panel bin-panel", "aria-label": "Bin" },
    h("h2", {}, "Bin"),
    bin,
    h(
      "form",
      {
        class: "row",
        onsubmit: async (event) => {
          event.preventDefault()
          try {
            await api("POST", `/projects/${id}/assets`, { path: addPath.value.trim() })
            addPath.value = ""
            await reload()
          } catch (error) {
            say.textContent = error.message
          }
        },
      },
      h("label", { for: "add-path", class: "sr-only" }, "Add a file by its path"),
      addPath,
      h("button", { class: "btn", type: "submit" }, "Add"),
    ),
  )

  /* The Director console (ED7): words, with the selection as "this", become a proposal */
  const prompt = h("input", { id: "prompt", class: "field", placeholder: "Ask for a change", autocomplete: "off" })
  const chip = h("span", { class: "chip selection", hidden: true })
  const proposalEl = h("div", { class: "proposal", "aria-live": "polite" })
  const did = h("ul", { class: "did", "aria-label": "What I did" })
  const selectionNow = () => {
    const words = transcript.selection()
    if (words) return { selection: { words }, label: `Selected: ${index.words.find((w) => w.id === words[0])?.text ?? ""}${words[0] === words[1] ? "" : " …"}` }
    if (timeline.selected) return { selection: { clip: timeline.selected }, label: `Selected: clip ${timeline.selected}` }
    return { selection: { at: monitor.time }, label: null }
  }
  const showChip = () => {
    const { label } = selectionNow()
    chip.hidden = !label
    chip.textContent = label ?? ""
  }
  transcriptEl.addEventListener("click", () => setTimeout(showChip))
  function showProposal(proposal) {
    clear(proposalEl)
    timeline.setGhost(proposal ? proposal.timeline : null)
    strip.setGhost(proposal ? proposal.timeline : null)
    if (!proposal) return
    const decide = async (accept, only) => {
      try {
        const result = await api("POST", `/projects/${id}/proposals/${proposal.id}`, { accept, ...(only ? { only } : {}) })
        say.textContent = result.dropped.length ? `Not applied, because you changed that part: ${result.dropped.map((d) => d.change).join("; ")}.` : accept ? "Done. Undo with Cmd+Z." : "Left as it was."
        if (accept) for (const change of only ? only.map((i) => proposal.changes[i]) : proposal.changes) did.prepend(h("li", {}, change))
      } catch (error) {
        say.textContent = error.message
      }
      showProposal(null)
      await reload()
    }
    proposalEl.append(
      h("p", { class: "lead" }, "Proposed, not applied yet"),
      h("ul", {}, proposal.changes.map((change, i) => h("li", {}, h("span", {}, change), proposal.changes.length > 1 ? h("button", { type: "button", class: "btn", onclick: () => decide(true, [i]) }, "Only this") : null))),
      h("div", { class: "row" }, h("button", { type: "button", class: "btn primary", onclick: () => decide(true) }, proposal.changes.length > 1 ? "Accept all" : "Accept"), h("button", { type: "button", class: "btn", onclick: () => decide(false) }, "Reject")),
    )
  }
  const promptForm = h(
    "form",
    {
      class: "prompt",
      onsubmit: async (event) => {
        event.preventDefault()
        const text = prompt.value.trim()
        if (!text) return
        say.textContent = "Thinking about that…"
        try {
          const { proposal, reason } = await api("POST", `/projects/${id}/ask`, { text, selection: selectionNow().selection })
          say.textContent = proposal ? "" : (reason ?? "Kriya couldn't turn that into an edit.")
          if (proposal) prompt.value = ""
          showProposal(proposal)
        } catch (error) {
          say.textContent = error.status === 0 || error.status >= 500 ? "I can't reach Kriya, so I can't make changes by asking. You can still edit by hand." : error.message
        }
      },
    },
    h("label", { for: "prompt", class: "sr-only" }, "Ask for a change"),
    prompt,
    h("button", { class: "btn primary", type: "submit" }, "Ask"),
  )
  const verdictWords = { delivered: "Checked", delivered_with_notes: "Checked, with notes", blocked: "Needs you", not_checked: "Not checked" }
  const makeButton = h(
    "button",
    {
      type: "button",
      class: "btn",
      onclick: async () => {
        try {
          const job = await api("POST", `/projects/${id}/make`, {})
          makeJob = job.id
          say.textContent = "Reading your footage. You can start working now."
        } catch (error) {
          say.textContent = error.message
        }
      },
    },
    "Make a reel",
  )
  let makeJob = null
  async function makeProgress() {
    if (!makeJob) return
    const job = (await api("GET", "/jobs")).jobs.find((j) => j.id === makeJob)
    if (!job || !["done", "failed", "canceled"].includes(job.status)) return
    makeJob = null
    if (job.status !== "done") return (say.textContent = job.error ?? "The reel stopped.")
    const result = JSON.parse(job.output)
    say.textContent = `${verdictWords[result.verdict] ?? result.verdict}. ${result.notes.join(" ")}`
    for (const change of [...result.changes].reverse()) did.prepend(h("li", {}, change))
  }

  /* transport */
  const play = h("button", { type: "button", class: "btn primary", onclick: () => act({ type: "toggle" }) }, "Play")
  const shapes = { project: () => project.canvas, "16:9": () => ({ width: 1920, height: 1080 }), "9:16": () => ({ width: 1080, height: 1920 }) }
  const shape = h("select", { class: "field small", "aria-label": "Preview shape", onchange: () => monitor.setShape(shapes[shape.value]()) }, ["project", "16:9", "9:16"].map((value) => h("option", { value }, value === "project" ? "Project shape" : value)))
  const zoom = h("input", { type: "range", min: "1", max: "3", step: "0.05", value: "1", class: "zoom", "aria-label": "Zoom", oninput: () => monitor.setZoom(Number(zoom.value)) })
  const guides = h("input", { type: "checkbox", id: "guides", onchange: () => monitor.setGuides(guides.checked) })

  function act(action) {
    if (!action) return
    if (action.type === "mode") return setMode(action.mode)
    if (action.type === "prompt") return prompt.focus()
    if (action.type === "undo") return api("PATCH", `/projects/${id}`, { undo: true }).then(reload)
    if (action.type === "redo") return (say.textContent = "Redo isn't here yet.")
    if (action.type === "split") {
      const piece = pieceAt(pieces, monitor.time)
      return piece && change([{ op: "split", clip: piece.clip, at: sourceAt(piece, monitor.time) }])
    }
    if (action.type === "delete") return timeline.selected && change([{ op: "ripple_delete", clip: timeline.selected }])
    const limits = { fps: source ? (assets.find((a) => a.id === source).facts.fps ?? fps()) : fps(), duration: durationNow() }
    const before = { t: monitor.time, rate: monitor.rate }
    const after = transport(before, action, limits)
    if (after.rate !== before.rate) monitor.setRate(after.rate)
    if (after.t !== before.t || action.type === "seek") monitor.seek(after.t)
  }

  function setMode(next) {
    mode = next
    remember("kriya-edit-mode", mode)
    root.dataset.mode = mode
    for (const button of modeButtons.querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.mode === mode))
    timeline.draw()
    strip.draw()
    if (mode === "finish") finish.refresh().catch(() => {})
  }
  const modeButtons = h("div", { class: "modes", role: "group", "aria-label": "Mode" }, MODES.map((m, i) => h("button", { type: "button", class: "btn", dataset: { mode: m }, "aria-pressed": "false", "aria-keyshortcuts": String(i + 1), onclick: () => setMode(m) }, m[0].toUpperCase() + m.slice(1))))

  const root = h(
    "div",
    { class: "workspace" },
    topBar(h("span", { class: "project-name" }, project.name), modeButtons),
    h(
      "div",
      { class: "grid" },
      h("div", { class: "area-bin" }, binPanel),
      h(
        "section",
        { class: "area-monitor panel", "aria-label": "Monitor" },
        h("div", { class: "monitor-frame" }, canvas),
        h("div", { class: "transport" }, play, time, which, shape, h("label", { class: "inline" }, guides, " Safe zones"), h("label", { class: "inline" }, "Zoom ", zoom)),
      ),
      h("aside", { class: "area-kriya panel", "aria-label": "Kriya" }, h("h2", {}, "Kriya"), makeButton, chip, promptForm, say, proposalEl, h("h2", {}, "What I did"), did),
      h("section", { class: "area-transcript panel", "aria-label": "Transcript" }, h("h2", {}, "Transcript"), transcriptEl),
      h("div", { class: "area-strip" }, stripEl),
      h("section", { class: "area-timeline panel", "aria-label": "Timeline" }, timelineEl),
      h("div", { class: "area-finish" }, finishEl),
    ),
  )
  clear(app).append(root)
  setMode(mode)

  window.onkeydown = (event) => {
    const typing = event.target.closest?.("input, select, textarea")
    if (typing && event.key !== "Escape") return
    if (event.key === "Escape") {
      // Escape lets go: of the field, then of the selection that "this" would mean
      if (typing) return document.activeElement?.blur()
      transcript.clear()
      timeline.select(null)
      return showChip()
    }
    const action = keyAction(event.key, { shift: event.shiftKey, mod: event.metaKey || event.ctrlKey })
    if (!action) return
    // A focused button keeps Space and Enter for itself, except the transport's own
    if (action.type === "toggle" && event.target.closest?.("button") && event.target !== play) return
    event.preventDefault()
    act(action)
  }
  setInterval(() => mode === "finish" && finish.scopes(), 250)
  new EventSource("/events").addEventListener("job", () => {
    if (mode === "finish") finish.refresh().catch(() => {})
    makeProgress().catch(() => {})
    reload().catch(() => {})
  })

  await reload()
  window.__studio = { monitor, act, reload, setMode, get pieces() { return pieces } } // for the Studio's own browser tests
}

/* ───────────────────────────── route ──────────────────────────── */

function route() {
  const match = /^#\/p\/([0-9a-f]{16})$/.exec(location.hash)
  if (match) workspace(match[1])
  else home()
}
window.addEventListener("hashchange", route)
route()
