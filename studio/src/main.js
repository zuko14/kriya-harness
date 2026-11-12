// The Kriya Editing Studio (UX_SPEC): its own app on the Edit Host's loopback origin.
// Home lists projects; a project opens the workspace in one of three modes. The
// monitor, transcript and timeline are made once per project and survive mode
// switches, so changing mode never resets playback.

import { fileName, GROUPS, groupBin, nameOf, searchBin, sortBin, SORTS, VIRTUAL_ABOVE, windowOf } from "./bin.js"
import { api, clear, h } from "./dom.js"
import { createFinish } from "./finish.js"
import { attachMentions, CLIP_MIME, thumbEl, tokensIn } from "./mentions.js"
import { createMonitor } from "./monitor.js"
import { createDrawing } from "./draw.js"
import { createDirectorStrip, createLookCards, createReplay, sheetCell, shouldAnimate } from "./director.js"
import { createShortcuts } from "./shortcuts.js"
import { meterFill } from "./live.js"
import { durationOf, programOf, shotMarks, sourceAt, sourceProgram, pieceAt, timelineAt } from "./program.js"
import { keyAction, snap, timecode, transport } from "./time.js"
import { assemblyOp, createStoryboard, movePart, partsOf, spineOf } from "./storyboard.js"
import { styleBriefCard } from "./style-brief.js"
import { variationsWall } from "./openings.js"
import { createTabs } from "./tabs.js"
import { createTimeline } from "./timeline.js"
import { createTranscript } from "./transcript.js"
import { answerOnBrief, FIELD_LABELS, understoodLine, valueText } from "./intent.js"

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

/* ──────────────────────────── folder picker ─────────────────────────── */

/**
 * Picks a folder on this computer through the Edit Host (a web page can't learn a real
 * path from the OS dialog): the folders the Host may use, with Up and New folder.
 * @returns {Promise<string | null>} the chosen folder, or null
 */
function pickFolder(start) {
  return new Promise((done) => {
    const list = h("ul", { class: "folders", "aria-label": "Folders" })
    const where = h("p", { class: "label-mono where" })
    const note = h("p", { class: "note", role: "status" })
    const newName = h("input", { class: "field", placeholder: "New folder name", "aria-label": "New folder name", maxlength: "80" })
    let current = null
    const close = (value) => {
      dialog.close()
      dialog.remove()
      done(value)
    }
    async function show(root) {
      try {
        const view = await api("GET", `/browse${root ? `?root=${encodeURIComponent(root)}` : ""}`)
        current = view.root
        where.textContent = view.root
        clear(list)
        if (view.parent) list.append(h("li", {}, h("button", { type: "button", class: "btn folder", onclick: () => show(view.parent) }, "↑ Up")))
        const folders = view.entries.filter((e) => e.kind === "folder")
        for (const entry of folders) list.append(h("li", {}, h("button", { type: "button", class: "btn folder", onclick: () => show(`${view.root}/${entry.name}`) }, `📁 ${entry.name}`)))
        if (!folders.length) list.append(h("li", { class: "note" }, "No folders here."))
        note.textContent = ""
      } catch (error) {
        note.textContent = error.message
      }
    }
    const dialog = h(
      "dialog",
      { class: "picker", "aria-label": "Choose a folder" },
      h("h2", {}, "Choose a folder"),
      where,
      list,
      h(
        "form",
        {
          class: "row tight",
          onsubmit: async (event) => {
            event.preventDefault()
            try {
              const { folder } = await api("POST", "/browse/folder", { parent: current, name: newName.value })
              newName.value = ""
              await show(folder)
            } catch (error) {
              note.textContent = error.message
            }
          },
        },
        newName,
        h("button", { type: "submit", class: "btn" }, "New folder"),
      ),
      note,
      h("div", { class: "row end" }, h("button", { type: "button", class: "btn", onclick: () => close(null) }, "Cancel"), h("button", { type: "button", class: "btn primary", onclick: () => close(current) }, "Use this folder")),
    )
    dialog.addEventListener("cancel", (event) => (event.preventDefault(), close(null)))
    document.body.append(dialog)
    dialog.showModal()
    show(start)
  })
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
  const folder = h("input", { id: "new-folder", class: "field", required: true, readonly: true, placeholder: "Choose a folder…" })
  const chooseFolder = h("button", { type: "button", class: "btn", onclick: () => pickFolder(folder.value || null).then((picked) => picked && ((folder.value = picked), (status.textContent = ""))) }, "Choose…")
  const status = h("p", { class: "note", role: "status" })
  const create = h(
    "form",
    {
      class: "panel new",
      onsubmit: async (event) => {
        event.preventDefault()
        if (!folder.value) return (status.textContent = "Choose a folder for the project first.")
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
    h("label", { for: "new-folder" }, "Folder for the project (its footage stays where it is)"),
    h("div", { class: "row tight" }, folder, chooseFolder),
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
      h(
        "section",
        { class: "panel" },
        h("h2", {}, "Projects"),
        projects.length
          ? h(
              "ul",
              { class: "projects" },
              projects.map((p) =>
                h(
                  "li",
                  { class: "project-row" },
                  h("a", { class: "btn open", href: `#/p/${p.id}` }, p.name),
                  h(
                    "button",
                    {
                      type: "button",
                      class: "btn ghost danger",
                      "aria-label": `Delete the project ${p.name}`,
                      onclick: async () => {
                        if (!confirm(`Delete "${p.name}" from the Studio?\n\nIts edit history, cache and index on this computer are removed. Your folder, footage, exports and the project file stay where they are.`)) return
                        try {
                          await api("DELETE", `/projects/${p.id}`)
                          home()
                        } catch (error) {
                          alert(error.message)
                        }
                      },
                    },
                    "Delete",
                  ),
                ),
              ),
            )
          : h("p", { class: "note" }, "No projects yet."),
      ),
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
  let formatFollowed = false // reload(): Format follows the project's frame once, on opening
  // editing.assembly, as this Kriya says (TP1): clip numbers and labels, the storyboard, mentions.
  // Off, nothing below draws and the page is the one it was
  const assemblyOn = view.assembly === true
  // editing.livePreview, as this Kriya says (TP3): the monitor draws the draft's plan, the timeline
  // trims by its edges, a proposal shows before and after. Off, nothing below draws or listens
  const liveOn = view.livePreview === true
  // TP9 (editing.customMotion, as this Kriya says): drawing on the frame and custom animations. Off, none of it is on the page
  const customOn = view.customMotion === true
  // editing.typeKit, as this Kriya says (TP7): style packs, the type kit, brand colours, more caption looks.
  // Off, none of it draws and the make panel is the one it was
  const typeKit = view.typeKit ?? null
  const MORE_LOOK_LABELS = { single: "One word", duo: "Two words", marker: "Marker", underline: "Underline", grow: "Grow", typewriter: "Typewriter", headline: "Headline", subtle: "Subtle" }
  let livePlan = null // GET /projects/{id}/preview, for the cut on the monitor
  let headNow = view.head ?? null // the version the Studio shows
  const thumbOf = (asset) => (asset.offline ? null : asset.kind === "video" ? { url: `/tiles/${asset.media}?kind=thumbs`, sheet: true } : asset.kind === "image" ? { url: `/media/${asset.media}`, sheet: false } : null)
  const clipOf = (asset) => ({ asset: asset.id, number: asset.number, name: nameOf(asset), duration: asset.facts.duration, thumb: thumbOf(asset) })
  const clipsNow = () => assets.filter((a) => a.number).map(clipOf)
  const fps = () => project.canvas.fps

  const time = h("span", { class: "time label-mono", "aria-live": "off" }, "00:00.00")
  const which = h("span", { class: "chip" }, "Preview")
  const canvas = h("canvas", { class: "monitor", role: "img", "aria-label": "Program monitor" })
  const say = h("p", { class: "note", role: "status", "aria-live": "polite" })
  // editing.livePreview: the sound's level beside the timer, and a badge on the monitor while it shows the Director's working cut or a replay
  const levelFill = liveOn ? h("span", { class: "level-fill" }) : null
  const level = liveOn ? h("span", { class: "level", "aria-hidden": "true", title: "Sound level of the preview" }, levelFill) : null
  const directorBadge = liveOn ? h("span", { class: "director-badge", hidden: true }, "Director working preview") : null
  const showLevel = () => {
    if (!levelFill) return
    const db = monitor.level()
    levelFill.style.width = `${(meterFill(db) * 100).toFixed(1)}%`
    level.classList.toggle("hot", db > -6)
  }

  const monitor = createMonitor({
    canvas,
    urlOf: (asset) => `/media/${assets.find((a) => a.id === asset).media}`,
    assetOf: (asset) => assets.find((a) => a.id === asset),
    onTime: (t) => {
      time.textContent = `${timecode(t, fps())} / ${timecode(durationNow(), fps())}`
      showLevel()
      timeline.setTime(t)
      strip.setTime(t)
      const piece = pieceAt(currentPieces(), t)
      const at = piece ? sourceAt(piece, t) : null
      const word = at === null ? null : index.words.find((w) => w.asset === piece.asset && at >= w.start && at < w.end)
      transcript.playing(word?.id ?? null)
    },
    onRate: (rate) => {
      if (rate === 0) (showLevel(), liveSoon())
      play.textContent = rate === 0 ? "Play" : "Pause"
      play.setAttribute("aria-label", rate === 0 ? "Play (Space)" : `Pause (Space), playing at ${rate}×`)
    },
    ...(liveOn ? { tileUrl: (key) => `/projects/${id}/tile-preview?key=${key}` } : {}),
  })
  const withPreview = (options) => (liveOn && livePlan ? { ...options, preview: livePlan } : options)
  // Declared before its first use in reload(); the select itself is made with the transport
  const shapeNow = () => ({ "16:9": { width: 1920, height: 1080 }, "9:16": { width: 1080, height: 1920 } })[shape.value] ?? project.canvas
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
    onFix: async (word, text) => {
      try {
        await api("POST", `/projects/${id}/words/${encodeURIComponent(word.id)}`, { text })
        say.textContent = `Fixed "${word.text}" to "${text}". Captions and Kriya use it from now on.`
      } catch (error) {
        say.textContent = error.message
      }
      await reload()
    },
  })
  // A video's thumbnail sheet: a frame every `every` seconds, 10 × 10 (the Engine's thumbs node)
  const sheetOf = (assetId) => {
    const asset = assets.find((a) => a.id === assetId)
    if (!asset || asset.offline || asset.kind !== "video" || !asset.facts?.duration) return null
    return { url: `/tiles/${asset.media}?kind=thumbs`, every: Math.max(1, Math.ceil(asset.facts.duration / 705_600_000 / 100)) }
  }
  const timeline = createTimeline({ root: timelineEl, onSeek: (t) => (showProgram(), monitor.seek(t)), ...(liveOn ? { onTrim: trimClip, rich: { thumbs: sheetOf } } : {}) })
  // An edge dragged on the timeline (TP3): one trim, so Cmd+Z undoes it. The source time follows
  // the piece at that edge, moving out past the cut as well as in
  function trimClip({ clip, edge, at }) {
    const parts = timelineData.picture.filter((p) => p.clip === clip).sort((a, b) => a.at - b.at)
    const piece = edge === "in" ? parts[0] : parts.at(-1)
    if (!piece || piece.hold) return
    const { n, d } = typeof piece.speed === "object" ? piece.speed : { n: 1, d: 1 }
    const length = assets.find((a) => a.id === piece.asset)?.facts.duration ?? piece.out
    const source = Math.min(length, Math.max(0, piece.in + Math.round(((snap(at, fps()) - piece.at) * n) / d)))
    const other = edge === "in" ? parts.at(-1).out : parts[0].in
    if (edge === "in" ? source >= other : source <= other) return (say.textContent = "That would leave nothing of the clip.")
    return change([{ op: "trim", clip, [edge]: source }])
  }
  // Where a dragged edge lands: the edges of words (in the cut, and just past each clip's ends) and the beats
  function trimSnaps() {
    const out = [...(livePlan?.beats ?? [])]
    const clips = new Map()
    for (const p of [...timelineData.picture].sort((a, b) => a.at - b.at)) clips.set(p.clip, [...(clips.get(p.clip) ?? []), p])
    for (const parts of clips.values()) {
      const [first, last] = [parts[0], parts.at(-1)]
      if (first.hold) continue
      const { n, d } = typeof first.speed === "object" ? first.speed : { n: 1, d: 1 }
      for (const w of index.words ?? []) {
        if (w.asset !== first.asset) continue
        for (const s of [w.start, w.end]) {
          const inside = timelineAt(parts, w.asset, s)
          const at = inside ?? (s < first.in ? first.at + Math.round(((s - first.in) * d) / n) : s >= last.out ? last.at + Math.round(((s - last.in) * d) / n) : null)
          if (at !== null) out.push(at)
        }
      }
    }
    return out
  }
  const strip = createTimeline({ root: stripEl, compact: true, onSeek: (t) => (showProgram(), monitor.seek(t)) })
  const finalEl = h("div", { class: "area-final" })
  const finish = createFinish({ root: finishEl, finalRoot: finalEl, pixels: () => monitor.pixels(), project: () => project, onAdjust: () => setMode("edit"), scorecard: liveOn, ...(liveOn ? { head: () => headNow, onShow: (at) => (setMode("edit"), showProgram(), monitor.seek(at)) } : {}) })

  function showProgram() {
    if (!source) return
    source = null
    which.textContent = "Preview"
    if (directorShowing && lastLive) return void showLive(lastLive)
    monitor.load(pieces, withPreview({ fps: fps(), duration: durationOf(pieces), shape: shapeNow() }))
  }
  function showSource(asset, at) {
    source = asset
    const facts = assets.find((a) => a.id === asset).facts
    which.textContent = "Source"
    monitor.load(sourceProgram(assets.find((a) => a.id === asset)), { fps: facts.fps ?? fps(), duration: facts.duration, shape: { width: facts.width ?? 1920, height: facts.height ?? 1080 } }).then(() => monitor.seek(at))
  }

  async function reload() {
    const [next, plan, found, preview] = await Promise.all([api("GET", `/projects/${id}`), api("GET", `/projects/${id}/plan`), api("GET", `/projects/${id}/index`), liveOn ? api("GET", `/projects/${id}/preview`).catch(() => null) : null])
    livePlan = preview
    project = next.project
    headNow = next.head
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
    if (liveOn) timeline.setSnaps(trimSnaps())
    if (liveOn) (timeline.setPreview(livePlan), lookCards?.refresh())
    strip.load({ picture: timelineData.picture }, { duration: total, fps: fps(), marks })
    transcript.load(index)
    showChip()
    renderBin()
    storyboard?.load(project)
    // On opening, Format follows the project's frame: found in use, a 16:9 project reopened
    // showed 9:16, so a plain "Make it" went back to 9:16. After that it's the person's choice
    if (!formatFollowed) {
      formatFollowed = true
      const frame = [...makeFormat.options].map((o) => o.value).find((f) => { const [a, b] = f.split(":").map(Number); return a * project.canvas.height === b * project.canvas.width })
      if (frame && project.sequences.some((q) => q.clips.length)) makeFormat.value = frame
    }
    // The preview shape the person chose holds through every reload (a finished Index used to reset it)
    // The cut as it now is: a proposal's "Preview: after" ends with its Accept or Reject
    if (!source) which.textContent = "Preview"
    // While the monitor follows the Director or a replay, a reload keeps that view; the cut returns when it ends
    if (!source && directorShowing && lastLive) await showLive(lastLive)
    else if (!source && !replay?.open) await monitor.load(pieces, withPreview({ fps: fps(), duration: total, shape: shapeNow() }))
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
  const jobsNow = new Map() // job id → its latest view, from the Host's events
  const indexing = (asset) => [...jobsNow.values()].find((j) => j.kind === "index" && j.asset === asset && ["pending", "running"].includes(j.status))
  // Width through the style property: the Studio's CSP refuses style attributes
  const progressBar = (value, label) => {
    const fill = h("span", { class: value === null ? "busy" : "" })
    if (value !== null) fill.style.width = `${value}%`
    return h("div", { class: "progress", role: "progressbar", "aria-label": label, "aria-valuemin": "0", "aria-valuemax": "100", ...(value === null ? {} : { "aria-valuenow": String(value) }) }, fill)
  }
  // The bin's search, sort and groups (TP1); drawn only with editing.assembly on
  const binSearch = h("input", { type: "search", id: "bin-search", class: "field", placeholder: "Label, file name or words said", autocomplete: "off", oninput: () => drawBin() })
  const binSort = h("select", { id: "bin-sort", class: "field select", "aria-label": "Sort the bin", onchange: () => drawBin() }, Object.entries(SORTS).map(([value, label]) => h("option", { value }, `Sort: ${label.toLowerCase()}`)))
  const binGroup = h("select", { id: "bin-group", class: "field select", "aria-label": "Group the bin", onchange: () => drawBin() }, Object.entries(GROUPS).map(([value, label]) => h("option", { value }, label)))
  const binTools = assemblyOn ? h("div", { class: "bin-tools" }, h("label", { for: "bin-search", class: "sr-only" }, "Search the bin"), binSearch, binSort, binGroup) : null
  const ROLES = { aroll: "Talking", broll: "B-roll", screen: "Screen recording", music: "Music", sfx: "Sound effect", logo: "Logo" }
  const BIN_ROW = { asset: 236, head: 36 } // row heights once the list is long enough to draw only what's in view (styles.css)

  /** The person's name for a clip, typed in place: Enter keeps it, Escape doesn't. An empty one takes the label away. */
  function rename(asset, el) {
    const input = h("input", { class: "field", value: asset.label ?? "", maxlength: "40", "aria-label": `Label for clip ${asset.number}`, placeholder: "A label, such as intro" })
    el.replaceWith(input)
    input.focus()
    input.select()
    let done = false
    const finish = (keep) => {
      if (done) return
      done = true
      const label = input.value.trim()
      input.replaceWith(el)
      if (keep && label !== (asset.label ?? "")) change([{ op: "describe_asset", asset: asset.id, label }])
      else el.focus()
    }
    input.addEventListener("keydown", (event) => {
      event.stopPropagation()
      if (event.key === "Enter") (event.preventDefault(), finish(true))
      else if (event.key === "Escape") (event.preventDefault(), finish(false))
    })
    input.addEventListener("blur", () => finish(true))
  }

  function binRow(asset) {
    const status = index.assets.find((a) => a.asset === asset.id)
    const words = status?.layers.find((l) => l.layer === "L2")
    const job = indexing(asset.id)
    const noWords = runtime?.speech ? "Indexed, no words yet: set up speech-to-text above" : (words?.notice ?? "Indexed, no words")
    const note = job ? `Reading this file… ${job.progress ?? 0}%` : !status ? "Not indexed" : words?.status === "ok" ? "Indexed" : noWords
    const media = ["video", "audio"].includes(asset.kind)
    const handle = assemblyOn && asset.number
    const open = h("button", { type: "button", class: "btn", onclick: () => showSource(asset.id, 0) }, `${handle ? nameOf(asset) : asset.path.split(/[\\/]/).at(-1)} · ${asset.kind}`)
    if (handle) {
      open.title = `${fileName(asset)}. Double-click or F2 to label it.`
      open.addEventListener("dblclick", () => rename(asset, open))
      open.addEventListener("keydown", (event) => event.key === "F2" && (event.preventDefault(), event.stopPropagation(), rename(asset, open)))
    }
    const role = handle ? h("select", { class: "field select", "aria-label": `What clip ${asset.number} is`, onchange: () => change([{ op: "describe_asset", asset: asset.id, role: role.value }]) }, [asset.role ? null : h("option", { value: "", disabled: true }, "What it is…"), ...Object.entries(ROLES).map(([value, label]) => h("option", { value }, label))]) : null
    if (role) role.value = asset.role ?? ""
    return h(
      "li",
      { class: `asset${handle ? " handle" : ""}`, ...(handle ? { draggable: "true", ondragstart: (event) => event.dataTransfer.setData(CLIP_MIME, JSON.stringify({ asset: asset.id })) } : {}) },
      handle ? h("div", { class: "asset-head" }, thumbEl(clipOf(asset)), h("span", { class: "badge", "aria-label": `Clip ${asset.number}` }, String(asset.number)), open) : open,
      h("span", { class: "note" }, asset.offline ? "Offline: the file has moved" : note),
      job ? progressBar(job.progress ?? 0, `Indexing ${asset.path.split(/[\\/]/).at(-1)}`) : null,
      role,
      media ? h("button", { type: "button", class: "btn", disabled: !!job, onclick: () => indexAsset(asset) }, status ? "Index again" : "Index") : null,
      media ? h("button", { type: "button", class: "btn", onclick: () => change([{ op: "keep_range", asset: asset.id, from: 0, to: asset.facts.duration }]) }, "Add to cut") : null,
    )
  }
  /** The bin's rows. Off, every file in the order added, as before; on, searched, sorted and grouped, and above 60 rows only those in view. */
  function drawBin() {
    const all = assets.filter((a) => a.kind !== "reference")
    const keep = document.activeElement === binSearch
    const scrolled = bin.scrollTop
    clear(bin)
    bin.classList.remove("virtual")
    if (!assemblyOn) return bin.append(...all.map(binRow))
    const found = sortBin(searchBin(all, index.words, binSearch.value), binSort.value)
    const rows = groupBin(found, binGroup.value).flatMap((group) => [...(group.name === null ? [] : [{ head: `${group.name} · ${group.assets.length}` }]), ...group.assets])
    const draw = (row) => (row.head ? h("li", { class: "bin-group label-mono" }, row.head) : binRow(row))
    if (binSearch.value.trim() && !found.length) bin.append(h("li", { class: "note" }, "Nothing in the bin matches that."))
    else if (rows.length <= VIRTUAL_ABOVE) bin.append(...rows.map(draw))
    else {
      bin.classList.add("virtual")
      const { start, end, before, after } = windowOf(rows.map((row) => (row.head ? BIN_ROW.head : BIN_ROW.asset)), scrolled, bin.clientHeight || 600)
      const space = (px) => {
        const gap = h("li", { class: "bin-space", "aria-hidden": "true" })
        gap.style.height = `${px}px`
        return gap
      }
      bin.append(space(before), ...rows.slice(start, end).map(draw), space(after))
      bin.scrollTop = scrolled
    }
    if (keep) binSearch.focus()
  }
  let binFrame = 0
  bin.addEventListener("scroll", () => bin.classList.contains("virtual") && (cancelAnimationFrame(binFrame), (binFrame = requestAnimationFrame(drawBin))))
  function renderBin() {
    drawBin()
    renderReferences()
  }
  async function indexAsset(asset) {
    // Speech needs the Media Runtime's recogniser: offer to set it up first, with its progress
    if (runtime?.speech && !runtime.setup?.error) {
      say.textContent = "Your file is indexed without words until speech-to-text is set up (above)."
      setupBox.hidden = false
    }
    try {
      const job = await api("POST", `/projects/${id}/index`, { asset: asset.id })
      jobsNow.set(job.id, { ...job, asset: asset.id })
      say.textContent = "Reading your footage. You can keep working."
      renderBin()
    } catch (error) {
      say.textContent = error.message
    }
  }

  /** Copies picked files into the project's media folder with a progress bar, then imports them. */
  function upload(files, { reference = false, aspect = "all" } = {}) {
    const one = (file) =>
      new Promise((done, fail) => {
        const row = h("li", { class: "asset" }, h("span", { class: "note" }, `Copying ${file.name}…`), progressBar(0, `Copying ${file.name}`))
        uploads.append(row)
        const xhr = new XMLHttpRequest()
        xhr.open("POST", `/projects/${id}/upload?name=${encodeURIComponent(file.name)}${reference ? "&as=reference" : ""}`)
        xhr.upload.onprogress = (event) => {
          if (!event.lengthComputable) return
          const pct = Math.round((event.loaded * 100) / event.total)
          row.querySelector(".progress span").style.width = `${pct}%`
          row.querySelector(".progress").setAttribute("aria-valuenow", String(pct))
          row.querySelector(".note").textContent = `Copying ${file.name}… ${pct}%`
        }
        xhr.onload = () => {
          row.remove()
          let value = {}
          try {
            value = JSON.parse(xhr.responseText)
          } catch {}
          xhr.status < 300 ? done(value) : fail(new Error(value.message ?? `The Edit Host answered ${xhr.status}.`))
        }
        xhr.onerror = () => (row.remove(), fail(new Error(`${file.name} couldn't be copied.`)))
        xhr.send(file)
      })
    return (async () => {
      for (const file of files) {
        try {
          const asset = await one(file)
          say.textContent = reference ? `Added ${file.name} as a reference for ${ASPECT[aspect].toLowerCase()}.` : `Added ${file.name}. Index it to read its words.`
          if (reference) (using.add(asset.id), remember(aspectKey(asset.id), aspect))
        } catch (error) {
          say.textContent = error.message
        }
      }
      await reload()
    })()
  }
  const uploads = h("ul", { class: "bin", "aria-label": "Copying" })
  const picker = h("input", { type: "file", multiple: true, accept: "video/*,audio/*,.mov,.mp4,.m4v,.mkv,.wav,.mp3,.m4a,.aac,.flac,.cube", hidden: true, id: "pick-files", onchange: () => (upload([...picker.files]), (picker.value = "")) })
  const addPath = h("input", { id: "add-path", class: "field", placeholder: "/Users/you/Movies/take.mov", autocomplete: "off" })
  const binPanel = h(
    "section",
    { class: "panel bin-panel", "aria-label": "Bin" },
    h("h2", {}, "Bin"),
    binTools,
    bin,
    uploads,
    picker,
    h("button", { type: "button", class: "btn primary wide", onclick: () => picker.click() }, "Add files…"),
    h("p", { class: "note small" }, "Copied into the project's media folder; your originals aren't touched."),
    h(
      "details",
      { class: "by-path" },
      h("summary", {}, "Link a file by its path instead (no copy)"),
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
        h("label", { for: "add-path", class: "sr-only" }, "Link a file by its path"),
        addPath,
        h("button", { class: "btn", type: "submit" }, "Link"),
      ),
    ),
  )

  /* references (EDD-23): videos whose style a cut takes, measured to numbers, never placed */
  // References in use for the next cut: each one added is on until switched off
  const using = new Set()
  const seenRefs = new Set()
  // What each reference is taken for (reference.js ASPECTS on the Host; the same words here):
  // the person picks it, so only that aspect of the reference shapes the cut. Kept per project
  const ASPECT = { all: "Everything it shows", editing: "Editing: cuts and pace", sound: "Sound: music and feel", colour: "Colour grade", graphics: "Graphics: captions and text" }
  const aspectKey = (rid) => `kriya-ref-aspect:${id}:${rid}`
  const aspectOf = (rid) => (Object.hasOwn(ASPECT, remember(aspectKey(rid)) ?? "") ? remember(aspectKey(rid)) : "all")
  const aspectSelect = (attrs, value, onchange) => h("select", { class: "field select", ...attrs, onchange }, Object.entries(ASPECT).map(([key, label]) => h("option", { value: key, selected: key === value }, label)))
  const addAspect = aspectSelect({ id: "ref-aspect", "aria-label": "The next reference is for" }, "all", () => (addAspectBin.value = addAspect.value))
  const addAspectBin = aspectSelect({ id: "ref-aspect-bin", "aria-label": "The next reference is for" }, "all", () => (addAspect.value = addAspectBin.value))
  const linesFor = (found, aspect) => {
    if (!found.parts) return found.lines
    if (aspect !== "all") return found.parts[aspect] ? [found.parts[aspect]] : [`Nothing to take for ${ASPECT[aspect].toLowerCase()} from this one.`]
    // As the Host takes "everything": a cut video's soundtrack is usually speech, so not its music
    return found.lines.filter((line) => !(found.kind === "video" && found.pace && line === found.parts.sound))
  }
  const analyses = new Map() // asset id → its classified analysis, from the Host
  // TP6 (editing.referenceIntent, as this Kriya says): a video reference's style, read as a job, and its brief.
  // Off, none of this is on the page and no make carries a style brief
  const referenceIntent = view.referenceIntent === true
  const styles = new Map() // reference id → { status, progress, brief, job, error }
  const offKey = (rid) => `kriya-ref-style-off:${id}:${rid}`
  const styleOff = (rid) => new Set((remember(offKey(rid)) ?? "").split(",").filter(Boolean))
  const loadStyle = (rid) => api("GET", `/projects/${id}/references/${encodeURIComponent(rid)}/brief?format=${encodeURIComponent(makeFormat.value)}`).then((found) => (styles.set(rid, found.status === "ready" ? { status: "ready", brief: found.brief } : { status: "none" }), renderReferences())).catch(() => (styles.set(rid, { status: "none" }), renderReferences()))
  async function readStyle(rid) {
    try {
      const job = await api("POST", `/projects/${id}/references/${encodeURIComponent(rid)}/measure`)
      jobsNow.set(job.id, job)
      styles.set(rid, { status: "measuring", progress: 0, job: job.id })
    } catch (error) {
      styles.set(rid, { status: "failed", error: error.message })
    }
    renderReferences(`style-cancel-direct-${rid}`)
  }
  // A reference job's events: its progress, then the brief it leaves, or why there is none
  function styleJob(job) {
    if (job?.kind !== "reference" || !job.asset) return
    if (job.status === "pending" || job.status === "running") styles.set(job.asset, { status: "measuring", progress: job.progress ?? 0, job: job.id })
    else if (job.status === "done") return void loadStyle(job.asset)
    else styles.set(job.asset, job.status === "canceled" ? { status: "none" } : { status: "failed", error: job.error ?? "the measure stopped" })
    renderReferences()
  }
  // The brief the next cut follows: the first reference in use, taken whole, whose style was read
  const styleNow = () => {
    if (!referenceIntent) return {}
    const ref = [...using].find((rid) => styles.get(rid)?.status === "ready" && aspectOf(rid) === "all" && assets.some((a) => a.id === rid && a.kind === "reference"))
    return ref ? { styleBrief: { ref, off: [...styleOff(ref)] } } : {}
  }
  const referencesEl = h("ul", { class: "bin", "aria-label": "References" })
  const directRefsEl = h("ul", { class: "bin refs-direct", "aria-label": "References for this cut" })
  const refSummary = h("p", { class: "note small" })
  const refPicker = h("input", {
    type: "file",
    accept: "video/*,image/*,audio/*,.mov,.mp4,.m4v,.mkv,.webm,.jpg,.jpeg,.png,.webp,.wav,.mp3,.m4a,.aac,.flac",
    hidden: true,
    id: "pick-reference",
    onchange: () => {
      const files = [...refPicker.files]
      refPicker.value = ""
      const aspect = addAspect.value
      const what = aspect === "all" ? "a video's pace, captions, colour and music; an image's colour grade; music's tempo and energy" : `only its ${ASPECT[aspect].toLowerCase()}`
      const ok = files.length && confirm(`Use this only as a reference for ${ASPECT[aspect].toLowerCase()}?\n\nKriya measures it as numbers: ${what}. No picture, sound or words from it go into your video. Add only what you're allowed to use this way.`)
      if (ok) upload(files, { reference: true, aspect })
    },
  })
  // One row per reference, in the bin's list (Edit) and in Direct's, each with its aspect and its switch
  function refRow(ref, where) {
    const name = ref.path.split(/[\\/]/).at(-1)
    const kind = ref.facts.width ? (ref.facts.duration ? "video" : "image") : "music"
    const on = h("input", { type: "checkbox", id: `use-${where}-${ref.id}`, checked: using.has(ref.id), onchange: () => (on.checked ? using.add(ref.id) : using.delete(ref.id), renderReferences(on.id)) })
    const found = analyses.get(ref.id)
    const aspect = aspectOf(ref.id)
    const lines = h("ul", { class: "ref-lines" }, ...(found ? linesFor(found, aspect).map((line) => h("li", {}, line)) : [h("li", { class: "note" }, "Measuring…")]))
    const take = aspectSelect({ id: `aspect-${where}-${ref.id}`, "aria-label": `Take from ${name}` }, aspect, (event) => (remember(aspectKey(ref.id), event.target.value), renderReferences(event.target.id)))
    const style = referenceIntent && kind === "video" ? styleBriefCard({ id: ref.id, where, state: styles.get(ref.id) ?? { status: "none" }, off: styleOff(ref.id), onRead: () => readStyle(ref.id), onCancel: () => styles.get(ref.id)?.job && api("DELETE", `/jobs/${encodeURIComponent(styles.get(ref.id).job)}`).catch(() => {}), onToggle: (trait, on) => { const off = styleOff(ref.id); on ? off.delete(trait) : off.add(trait); remember(offKey(ref.id), [...off].join(",")); renderReferences(`style-${where}-${ref.id}-${trait}`) } }) : null
    return h("li", { class: "asset ref" }, h("button", { type: "button", class: "btn", onclick: () => ref.facts.duration && showSource(ref.id, 0) }, `${name} · ${kind}`), h("label", { class: "note small", for: `aspect-${where}-${ref.id}` }, "Take from it"), take, referenceIntent && styles.get(ref.id)?.status === "ready" && aspect === "all" ? null : lines, style, h("label", { class: "inline", for: `use-${where}-${ref.id}` }, on, " Use in the cut"))
  }
  function renderReferences(focus = null) {
    clear(referencesEl)
    clear(directRefsEl)
    const refs = assets.filter((a) => a.kind === "reference")
    if (!refs.length) referencesEl.append(h("li", { class: "note" }, "None yet. Pick what a reference is for, then add a video whose cuts you like, music whose feel you like, or an image whose colour you like."))
    for (const ref of refs) {
      if (!seenRefs.has(ref.id)) (seenRefs.add(ref.id), using.add(ref.id))
      referencesEl.append(refRow(ref, "bin"))
      directRefsEl.append(refRow(ref, "direct"))
      if (!analyses.has(ref.id)) {
        analyses.set(ref.id, null) // asked once, though it shows in two lists
        api("GET", `/projects/${id}/references/${encodeURIComponent(ref.id)}`).then((result) => (analyses.set(ref.id, result), renderReferences())).catch((error) => (analyses.set(ref.id, { lines: [`Couldn't measure it: ${error.message}`] }), renderReferences()))
      }
      // TP6: a brief the measuring job left earlier is shown at once; asking never measures
      if (referenceIntent && ref.facts.width && ref.facts.duration && !styles.has(ref.id)) {
        styles.set(ref.id, { status: "none" })
        void loadStyle(ref.id)
      }
    }
    showRefSummary()
    if (focus) document.getElementById(focus)?.focus()
    // The make panel's choices follow what's in the project
    const keep = (select, list, none) => {
      const was = select.value
      clear(select).append(h("option", { value: "" }, none), ...list.map((a) => h("option", { value: a.id }, a.path.split(/[\\/]/).at(-1))))
      select.value = list.some((a) => a.id === was) ? was : ""
    }
    keep(makeMusic, assets.filter((a) => a.kind === "audio" && !/kriya-music-/.test(a.path)), "No music")
    // TP7: a logo is an image of the bin's (role logo first); the corner bug is drawn across the cut
    // A person's own PNG comes in as a picture with a width: any still, or anything they marked as the logo
    if (makeLogo) keep(makeLogo, assets.filter((a) => a.kind === "image" || a.role === "logo" || (a.kind === "video" && /\.(?:png|jpe?g|webp)$/i.test(a.path))).sort((a, b) => (b.role === "logo") - (a.role === "logo")), "Logo: none")
    // Music Kriya writes itself, royalty-free by construction, before the person's own files
    const was = makeMusic.value
    makeMusic.insertBefore(h("optgroup", { label: "Made by Kriya" }, h("option", { value: "generated:calm" }, "Music: calm bed (made by Kriya)"), h("option", { value: "generated:upbeat" }, "Music: upbeat bed (made by Kriya)"), h("option", { value: "generated:warm" }, "Music: warm bed (made by Kriya)")), makeMusic.options[1] ?? null)
    if (/^generated:/.test(musicChoice)) makeMusic.value = musicChoice
    else if (was) makeMusic.value = was
  }

  /* the Media Runtime: speech-to-text needs it; set up here, with progress */
  let runtime = null
  const setupLine = h("p", { class: "note" })
  const setupBar = h("div")
  const setupButton = h("button", { type: "button", class: "btn primary", onclick: () => api("POST", "/runtime/setup").then(showRuntime).catch((error) => (setupLine.textContent = error.message)) }, "Set up speech-to-text")
  const setupBox = h("section", { class: "panel setup", "aria-label": "Speech-to-text setup", hidden: true }, h("h2", {}, "Speech-to-text"), setupLine, setupBar, setupButton)
  const mb = (bytes) => (bytes / 1e6).toLocaleString(undefined, { maximumFractionDigits: 0 })
  function showRuntime(next) {
    runtime = next
    const job = runtime.setup
    const running = job && !job.finished
    setupBox.hidden = !runtime.speech && !running && !job?.error
    setupButton.hidden = !!running
    setupButton.textContent = job?.error ? "Try again" : "Set up speech-to-text"
    clear(setupBar)
    if (running) {
      const pct = job.total ? Math.round((job.done * 100) / job.total) : null
      setupLine.textContent = job.total ? `Downloading ${job.step}: ${mb(job.done)} of ${mb(job.total)} MB (${pct}%)` : (job.line ?? "Setting up…")
      setupBar.append(progressBar(pct, "Media Runtime setup"))
    } else if (job?.error) setupLine.textContent = `Setup stopped: ${job.error}`
    else if (runtime.speech) setupLine.textContent = `Words in the transcript need the speech model on this computer. Setting it up downloads it once; after that it works offline.`
    else if (job?.finished) setupLine.textContent = "Ready. Index a file to read its words."
  }

  /* Chat with Kriya (ED7's console): words, times like 0:05, a marked range or a selection
     as "this" become proposals; questions get answers. Kriya's words are only ever text */
  const prompt = h("textarea", { id: "prompt", class: "field chat-input", rows: "2", placeholder: "Tell Kriya: \"remove 0:05 to 0:09\", \"change the caption at 0:12 to …\", \"make the start punchier\"", autocomplete: "off" })
  const chip = h("span", { class: "chip selection", hidden: true })
  /* The storyboard and mentions (TP1, ASSEMBLY_AND_INTENT §4.1, §4.2), only with editing.assembly on.
     Every storyboard action is one set_assembly, so Cmd+Z undoes it */
  const storyEl = assemblyOn ? h("section", { class: "area-story panel storyboard", "aria-label": "Storyboard" }) : null
  const storyboard = assemblyOn ? createStoryboard({ root: storyEl, clips: clipsNow, words: () => index.words ?? [], onChange: (parts) => change([assemblyOp(parts)]) }) : null
  const mentionBox = assemblyOn ? attachMentions({ input: prompt, clips: clipsNow }) : null
  // The words selected in the transcript, as a stretch of their file
  const stretchNow = () => {
    const [first, last] = (transcript.selection() ?? []).map((wid) => index.words.find((w) => w.id === wid))
    return first && last ? { asset: first.asset, from: first.start, to: last.end } : null
  }
  const mentionThis = assemblyOn ? h("button", { type: "button", class: "btn", hidden: true, title: "Point at the selected words in your message", onclick: () => stretchNow() && mentionBox.insert(stretchNow()) }, "Mention this") : null
  if (assemblyOn) {
    prompt.placeholder = "Tell Kriya what to change. Type @ to point at a clip."
    // Selected words can be dragged onto the chat box or the storyboard
    transcriptEl.addEventListener("dragstart", (event) => stretchNow() && event.dataTransfer.setData(CLIP_MIME, JSON.stringify(stretchNow())))
  }
  const chatEl = h("ol", { class: "chat", "aria-label": "Chat with Kriya", "aria-live": "polite" })
  const did = h("ul", { class: "did", "aria-label": "What I did" })
  const history = [] // the chat's turns, sent back (short) so a follow-up has its context
  let markIn = null
  let markOut = null
  const clock = (flicks) => {
    const total = Math.max(0, flicks) / 705_600_000
    const minutes = Math.floor(total / 60)
    return `${minutes}:${(total - minutes * 60).toFixed(1).padStart(4, "0")}`
  }
  const selectionNow = () => {
    if (markIn !== null && markOut !== null && markOut > markIn) return { selection: { from: markIn, to: markOut }, label: `Marked ${clock(markIn)}–${clock(markOut)}` }
    const words = transcript.selection()
    if (words) return { selection: { words }, label: `Selected: ${index.words.find((w) => w.id === words[0])?.text ?? ""}${words[0] === words[1] ? "" : " …"}` }
    if (timeline.selected) return { selection: { clip: timeline.selected }, label: `Selected: clip ${timeline.selected}` }
    if (markIn !== null) return { selection: { at: markIn }, label: `Marked in at ${clock(markIn)} (press O for the end)` }
    return { selection: { at: monitor.time }, label: null }
  }
  const showChip = () => {
    const { label } = selectionNow()
    chip.hidden = !label
    chip.textContent = label ?? ""
    if (!assemblyOn) return
    mentionThis.hidden = !transcript.selection()
    for (const el of transcriptEl.querySelectorAll(".word")) el.draggable = el.getAttribute("aria-pressed") === "true"
  }
  transcriptEl.addEventListener("click", () => setTimeout(showChip))

  /** Text with its times (0:05, 1:02.5) as buttons that seek the cut there. */
  function withTimes(text) {
    const out = []
    let last = 0
    for (const m of String(text).matchAll(/\b(\d{1,2}):(\d{2}(?:\.\d+)?)\b/g)) {
      out.push(text.slice(last, m.index))
      const at = Math.round((Number(m[1]) * 60 + Number(m[2])) * 705_600_000)
      out.push(h("button", { type: "button", class: "time-link", title: "Play from here", onclick: () => (showProgram(), monitor.seek(Math.min(at, Math.max(0, durationOf(pieces) - 1)))) }, m[0]))
      last = m.index + m[0].length
    }
    out.push(text.slice(last))
    return out
  }
  function message(who, text, ...more) {
    // A mention shows as a chip; its stretch is of the file, so it isn't a time to seek the cut to
    const words = who === "you" && mentionBox ? tokensIn(text).flatMap((part) => (part.number ? [h("span", { class: "chip mention" }, part.text)] : withTimes(part.text))) : withTimes(text)
    const li = h("li", { class: `msg ${who}` }, h("span", { class: "who" }, who === "you" ? "You" : "Kriya"), h("p", {}, ...words), ...more)
    chatEl.append(li)
    li.scrollIntoView({ block: "nearest" })
    return li
  }
  function proposalBlock(proposal) {
    proposalGhost = proposal.timeline ?? null
    timeline.setGhost(proposal.timeline)
    strip.setGhost(proposal.timeline)
    const box = h("div", { class: "proposal" })
    const decide = async (accept, only) => {
      try {
        const result = await api("POST", `/projects/${id}/proposals/${proposal.id}`, { accept, ...(only ? { only } : {}) })
        say.textContent = result.dropped.length ? `Not applied, because you changed that part: ${result.dropped.map((d) => d.change).join("; ")}.` : accept ? "Done. Undo with Cmd+Z." : "Left as it was."
        if (accept) for (const change of only ? only.map((i) => proposal.changes[i]) : proposal.changes) did.prepend(h("li", {}, change))
        clear(box).append(h("p", { class: "note" }, accept ? (result.dropped.length ? "Partly applied." : "Applied.") : "Not applied."))
      } catch (error) {
        say.textContent = error.message
      }
      proposalGhost = null
      timeline.setGhost(null)
      strip.setGhost(null)
      await reload()
    }
    // Before and after on the monitor (TP3): the cut as it is, or as it would be, drawn from each one's own plan
    const compare = liveOn && proposal.timeline
      ? (() => {
          const buttons = {}
          const showIt = async (after) => {
            try {
              if (after) {
                const plan = await api("GET", `/projects/${id}/preview?proposal=${encodeURIComponent(proposal.id)}`)
                const next = programOf(proposal.timeline)
                await monitor.load(next, { fps: fps(), duration: durationOf(next), shape: shapeNow(), preview: plan })
              } else await monitor.load(pieces, withPreview({ fps: fps(), duration: durationOf(pieces), shape: shapeNow() }))
              which.textContent = after ? "Preview: after" : "Preview"
              buttons.before.setAttribute("aria-pressed", String(!after))
              buttons.after.setAttribute("aria-pressed", String(after))
            } catch (error) {
              say.textContent = error.message
            }
          }
          buttons.before = h("button", { type: "button", class: "btn", "aria-pressed": "true", onclick: () => showIt(false) }, "Before")
          buttons.after = h("button", { type: "button", class: "btn", "aria-pressed": "false", onclick: () => showIt(true) }, "After")
          return h("div", { class: "row compare", role: "group", "aria-label": "Show on the monitor" }, buttons.before, buttons.after)
        })()
      : null
    // TP9: a custom animation, as the render draws it, in its own sandboxed frame; Approve, Restyle or Remove
    const custom = customOn && proposal.motion
      ? (() => {
          const w = project.canvas.width
          const hh = project.canvas.height
          const show = Math.min(220, Math.round((220 * w) / Math.max(w, hh)))
          const src = `/projects/${id}/custom-preview?proposal=${encodeURIComponent(proposal.id)}&op=${proposal.motion.op}`
          const frame = h("iframe", { title: "Preview of the custom animation", sandbox: "allow-scripts", loading: "lazy", src })
          Object.assign(frame.style, { width: `${w}px`, height: `${hh}px`, transform: `scale(${show / w})` })
          const picture = h("div", { class: "scene-picture custom-picture" }, frame)
          Object.assign(picture.style, { width: `${show}px`, height: `${Math.round((show * hh) / w)}px` })
          const checks = (proposal.motion.gates ?? []).map((g) => `${g.id} ${g.status.replaceAll("_", " ")}`).join(" · ")
          const restyle = () => {
            prompt.value = `${proposal.ask ?? "That animation"}, in a different style`
            decide(false).then(() => send())
          }
          return h(
            "div",
            { class: "scene-row custom-motion" },
            picture,
            h(
              "div",
              { class: "scene-info" },
              h("p", { class: "small" }, "Custom animation, written by a model and checked by code"),
              checks ? h("p", { class: "note small" }, `Checked on its own tile: ${checks}`) : null,
              h("div", { class: "row" }, h("button", { type: "button", class: "btn primary", onclick: () => decide(true) }, "Approve"), h("button", { type: "button", class: "btn", onclick: () => (frame.src = src) }, "Play again"), h("button", { type: "button", class: "btn", onclick: restyle }, "Restyle"), h("button", { type: "button", class: "btn", onclick: () => decide(false) }, "Remove")),
            ),
          )
        })()
      : null
    box.append(
      h("p", { class: "lead" }, "Proposed, not applied yet"),
      ...(custom ? [custom] : []),
      ...(compare ? [compare] : []),
      h("ul", {}, proposal.changes.map((change, i) => h("li", {}, h("span", {}, ...withTimes(change)), proposal.changes.length > 1 ? h("button", { type: "button", class: "btn", onclick: () => decide(true, [i]) }, "Only this") : null))),
      // A custom animation alone is answered by its own Approve and Remove
      ...(custom && proposal.changes.length === 1 ? [] : [h("div", { class: "row" }, h("button", { type: "button", class: "btn primary", onclick: () => decide(true) }, proposal.changes.length > 1 ? "Accept all" : "Accept"), h("button", { type: "button", class: "btn", onclick: () => decide(false) }, "Reject"))]),
    )
    return box
  }
  /* The Director's plan: pitched in words with its settings; approve it, or say what to
     change and it's revised. Nothing is made until it's approved */
  let pendingPlan = null
  // Which tab of the Kriya panel shows (set once the panel is built; before that, nothing to switch)
  let showTab = () => {}
  const choicesNow = () => ({ ...briefNow(), ...(makeVoice.value === "clean" ? { cleanVoice: true } : {}) })
  const wordText = (wid) => index.words.find((w) => w.id === wid)?.text ?? wid
  const clockOf = (n) => `${Math.floor(n / 60)}:${(n % 60).toFixed(1).padStart(4, "0")}`
  let planGenre = null
  function settingsLine(settings = {}) {
    const parts = [
      planGenre,
      settings.format,
      settings.seconds ? `about ${settings.seconds} s` : null,
      settings.captions && settings.captions !== "none" ? `${settings.captions} captions` : "no captions",
      settings.grade && settings.grade !== "natural" ? `${settings.grade} look` : "natural colour",
      settings.music && settings.music !== "none" ? `${settings.music} music` : "no music",
      settings.cleanVoice ? "background noise out of the voice" : null,
      settings.coldOpen ? `cold open on "${wordText(settings.coldOpen.from)} … ${wordText(settings.coldOpen.to)}"${settings.coldOpen.mono === false ? "" : " in black and white"}` : null,
      settings.hook ? "a hook line first" : null,
      settings.cutSound && settings.cutSound !== "none" ? `a ${settings.cutSound} on each cut` : null,
      settings.introSound && settings.introSound !== "none" ? `a ${settings.introSound} into the story` : null,
      Number.isInteger(settings.punches) ? `${settings.punches} punch-ins` : null,
      settings.angles ? "wide and tight angles" : null,
      // TP10: the sound arranged to the cut, present only on a plan made with editing.craft
      settings.arrange ? "an accent in the music's key on every join" : null,
      settings.ambience ? "a room tone from your own quiet" : null,
      settings.splits ? "the voice leading and trailing its picture at the joins" : null,
      settings.beatJoins ? "B-roll on the beat" : null,
      settings.broll === "own" ? "B-roll from your clips" : null,
      settings.titles ? "title cards" : null,
      settings.scenes?.length ? `${settings.scenes.length} animated scene${settings.scenes.length === 1 ? "" : "s"}` : null,
      settings.graphics?.length ? `${settings.graphics.length} motion graphic${settings.graphics.length === 1 ? "" : "s"}` : null,
      settings.transition && settings.transition !== "none" ? `${settings.transition} transitions ${settings.transitionAll ? "on every cut" : "where the story changes moment"}` : null,
      settings.pictures?.length ? `${settings.pictures.length} licensed picture${settings.pictures.length === 1 ? "" : "s"}` : null,
      settings.terms?.length ? `${settings.terms.length} cited definition${settings.terms.length === 1 ? "" : "s"}` : null,
      settings.song ? "your song" : null,
      settings.montage ? "cut on its beats" : null,
      settings.multicam ? `${settings.multicam.angles.length} cameras, following who speaks` : null,
      settings.ramps ? "a speed ramp into the story" : null,
      settings.cuts?.length ? `trims ${settings.cuts.map((c) => `${clockOf(c.from)}–${clockOf(c.to)}`).join(", ")} of the take` : null,
    ]
    return parts.filter(Boolean).join(" · ")
  }
  /**
   * The plan's animated scenes: each one playing as the render will draw it, with what it can
   * be swapped to and a way to keep the speaker there instead. What's left is what an approval makes.
   */
  function sceneCards(plan, changed) {
    const choices = plan.sceneChoices ?? { kinds: {}, themes: {}, swaps: [] }
    const format = plan.settings.format ?? makeFormat.value
    const wide = format === "16:9"
    const size = wide ? { w: 1920, h: 1080, show: 200 } : format === "1:1" ? { w: 1080, h: 1080, show: 150 } : format === "4:5" ? { w: 1080, h: 1350, show: 136 } : { w: 1080, h: 1920, show: 120 }
    const rows = plan.settings.scenes.map((scene, i) => ({ scene, swaps: choices.swaps[i] ?? [scene.kind] }))
    const list = h("ul", { class: "scene-list" })
    const save = () => {
      plan.settings.scenes = rows.map((row) => row.scene)
      if (rows.length) plan.brief.scenes = plan.settings.scenes
      else delete plan.brief.scenes
      changed()
    }
    const source = (scene) => `/projects/${id}/scene-preview?format=${encodeURIComponent(format)}&scene=${encodeURIComponent(JSON.stringify(scene))}`
    const timeOf = (scene) => {
      const seconds = (flicks) => clockOf(flicks / 705_600_000)
      const from = index.words?.find((w) => w.id === scene.from)
      const to = index.words?.find((w) => w.id === scene.to)
      return from && to ? `${seconds(from.start)}–${seconds(to.end)}` : ""
    }
    const draw = () => {
      clear(list)
      if (!rows.length) list.append(h("li", { class: "note small" }, "No animated scenes: the speaker stays on screen."))
      for (const row of rows) {
        const frame = h("iframe", { title: `Preview of the scene "${row.scene.title || row.scene.items[0].text}"`, sandbox: "allow-scripts", loading: "lazy", src: source(row.scene) })
        frame.style.width = `${size.w}px`
        frame.style.height = `${size.h}px`
        frame.style.transform = `scale(${size.show / size.w})`
        const picture = h("div", { class: "scene-picture" }, frame)
        picture.style.width = `${size.show}px`
        picture.style.height = `${Math.round((size.show * size.h) / size.w)}px`
        const kind = h("select", { class: "field select", "aria-label": "Draw this scene as", onchange: () => ((row.scene = { ...row.scene, kind: kind.value }), save(), (frame.src = source(row.scene))) }, row.swaps.map((option) => h("option", { value: option }, choices.kinds[option] ?? option)))
        kind.value = row.scene.kind
        list.append(
          h(
            "li",
            { class: "scene-row" },
            picture,
            h(
              "div",
              { class: "scene-info" },
              h("p", { class: "small" }, h("span", { class: "scene-time" }, timeOf(row.scene)), ` ${row.scene.title || row.scene.items[0].text}`),
              h("p", { class: "note small" }, row.scene.items.map((item) => `${item.text}${item.value !== undefined ? ` ${item.value}${item.unit ?? ""}` : ""}`).join(" · ")),
              h(
                "div",
                { class: "row" },
                kind,
                h("button", { type: "button", class: "btn", onclick: () => (frame.src = source(row.scene)) }, "Play again"),
                h("button", { type: "button", class: "btn", onclick: () => (rows.splice(rows.indexOf(row), 1), save(), draw()) }, "Keep the speaker"),
              ),
            ),
          ),
        )
      }
    }
    const look = h(
      "select",
      { class: "field select", "aria-label": "Look of the scenes", onchange: () => { for (const row of rows) row.scene = { ...row.scene, theme: look.value }; save(); draw() } },
      Object.entries(choices.themes).map(([value, label]) => h("option", { value }, label)),
    )
    look.value = rows[0].scene.theme
    draw()
    return h("div", { class: "scenes" }, h("div", { class: "row scene-head" }, h("p", { class: "lead" }, "Animated scenes"), look), list)
  }
  /**
   * The plan's motion graphics: each playing as the render will draw it, restyled or removed
   * here. The words are the speaker's or the person's own, so they aren't edited on the card.
   */
  function graphicCards(plan, changed) {
    const choices = plan.graphicChoices ?? { kinds: {}, styles: {}, accents: [], tones: [], fonts: [] }
    const format = plan.settings.format ?? makeFormat.value
    const size = format === "16:9" ? { w: 1920, h: 1080, show: 200 } : format === "1:1" ? { w: 1080, h: 1080, show: 150 } : format === "4:5" ? { w: 1080, h: 1350, show: 136 } : { w: 1080, h: 1920, show: 120 }
    let rows = [...plan.settings.graphics]
    const list = h("ul", { class: "scene-list" })
    const save = () => {
      plan.settings.graphics = rows
      if (rows.length) plan.brief.graphics = rows
      else delete plan.brief.graphics
      changed()
    }
    const source = (graphic) => `/projects/${id}/graphic-preview?format=${encodeURIComponent(format)}&graphic=${encodeURIComponent(JSON.stringify(graphic))}`
    const when = (graphic) => {
      const word = graphic.at && index.words?.find((w) => w.id === graphic.at)
      return graphic.kind === "intro" ? "start" : graphic.kind === "end" ? "end" : word ? clockOf(word.start / 705_600_000) : ""
    }
    const draw = () => {
      clear(list)
      if (!rows.length) list.append(h("li", { class: "note small" }, "No motion graphics."))
      rows.forEach((graphic, i) => {
        const kind = choices.kinds[graphic.kind] ?? { label: graphic.kind, styles: [graphic.style] }
        const frame = h("iframe", { title: `Preview of the ${kind.label.toLowerCase()} "${graphic.text}"`, sandbox: "allow-scripts", loading: "lazy", src: source(graphic) })
        frame.style.width = `${size.w}px`
        frame.style.height = `${size.h}px`
        frame.style.transform = `scale(${size.show / size.w})`
        const picture = h("div", { class: "scene-picture graphic-picture" }, frame)
        picture.style.width = `${size.show}px`
        picture.style.height = `${Math.round((size.show * size.h) / size.w)}px`
        const style = kind.styles.length > 1 ? h("select", { class: "field select", "aria-label": `Style of the ${kind.label.toLowerCase()}`, onchange: () => ((rows[i] = { ...rows[i], style: style.value }), save(), (frame.src = source(rows[i]))) }, kind.styles.map((option) => h("option", { value: option }, choices.styles[option] ?? option))) : null
        if (style) style.value = graphic.style
        list.append(
          h(
            "li",
            { class: "scene-row" },
            picture,
            h(
              "div",
              { class: "scene-info" },
              h("p", { class: "small" }, h("span", { class: "scene-time" }, when(graphic)), ` ${kind.label}`),
              h("p", { class: "note small" }, [graphic.text, graphic.subtitle].filter(Boolean).join(" · ")),
              h("div", { class: "row" }, style, h("button", { type: "button", class: "btn", onclick: () => (frame.src = source(rows[i])) }, "Play again"), h("button", { type: "button", class: "btn", onclick: () => ((rows = rows.filter((_, n) => n !== i)), save(), draw()) }, "Remove")),
            ),
          ),
        )
      })
    }
    // The brand kit: one colour, plate and font for every graphic in the cut
    const brand = (key, options, label) => {
      const select = h("select", { class: "field select", "aria-label": label, onchange: () => ((rows = rows.map((graphic) => ({ ...graphic, [key]: select.value }))), save(), draw()) }, options.map((value) => h("option", { value }, `${label}: ${value}`)))
      select.value = rows[0][key]
      return select
    }
    const kit = h("div", { class: "row" }, brand("accent", choices.accents, "Colour"), brand("tone", choices.tones, "Plate"), brand("font", choices.fonts, "Font"))
    draw()
    return h("div", { class: "scenes" }, h("p", { class: "lead" }, "Motion graphics"), kit, list)
  }
  /** Real pictures found for what's named: each with its licence and credit, swappable, removable. Nothing downloads until approval. */
  function pictureCards(plan, changed) {
    const list = h("ul", { class: "scene-list" })
    const save = () => {
      plan.brief.pictures = plan.settings.pictures.map(({ from, to, id: found }) => ({ from, to, id: found }))
      if (!plan.brief.pictures.length) delete plan.brief.pictures
      changed()
    }
    const draw = () => {
      clear(list)
      if (!plan.settings.pictures.length) list.append(h("li", { class: "note small" }, "No pictures: the speaker stays on screen."))
      for (const picture of plan.settings.pictures) {
        const shown = () => picture.options.find((o) => o.id === picture.id) ?? picture.options[0]
        const thumb = h("img", { class: "found-thumb", alt: shown().title, loading: "lazy", src: `/projects/${id}/found-thumb?id=${encodeURIComponent(picture.id)}` })
        const credit = h("p", { class: "note small" }, `${shown().licence} · ${shown().creator}`)
        const pick = h("select", { class: "field select", "aria-label": "Use this picture", onchange: () => {
          picture.id = pick.value
          thumb.src = `/projects/${id}/found-thumb?id=${encodeURIComponent(picture.id)}`
          thumb.alt = shown().title
          credit.textContent = `${shown().licence} · ${shown().creator}`
          save()
        } }, picture.options.map((o) => h("option", { value: o.id }, o.title.slice(0, 60))))
        pick.value = picture.id
        list.append(h("li", { class: "scene-row" }, thumb, h("div", { class: "scene-info" }, h("p", { class: "small" }, picture.query), credit, h("div", { class: "row" }, pick, h("button", { type: "button", class: "btn", onclick: () => {
          plan.settings.pictures.splice(plan.settings.pictures.indexOf(picture), 1)
          save()
          draw()
        } }, "Keep the speaker")))))
      }
    }
    draw()
    return h("div", { class: "scenes" }, h("p", { class: "lead" }, "Real pictures"), list)
  }
  /** Definitions shown on screen: quoted, with where they come from. */
  function termCards(plan, changed) {
    const list = h("ul", { class: "scene-list" })
    const draw = () => {
      clear(list)
      for (const term of plan.settings.terms) {
        list.append(h("li", { class: "scene-row" }, h("div", { class: "scene-info" }, h("p", { class: "small" }, h("b", {}, term.term), ` “${term.quote}” ${term.source}`), h("button", { type: "button", class: "btn", onclick: () => {
          plan.settings.terms.splice(plan.settings.terms.indexOf(term), 1)
          plan.brief.terms = plan.settings.terms.map(({ at, id: found, term: said }) => ({ at, id: found, term: said }))
          if (!plan.brief.terms.length) delete plan.brief.terms
          changed()
          draw()
        } }, "Don't show this"))))
      }
    }
    draw()
    return h("div", { class: "scenes" }, h("p", { class: "lead" }, "Definitions"), list)
  }
  /** TP7: the plan's style pack, on the card; the person's to keep, change or drop before approving. */
  function styleChoice(plan) {
    const pick = h("select", { class: "field select", "aria-label": "Style pack", onchange: () => {
      if (pick.value) plan.brief.stylePack = plan.settings.stylePack = pick.value
      else {
        delete plan.brief.stylePack
        delete plan.settings.stylePack
      }
    } }, [h("option", { value: "" }, "No style pack"), ...Object.entries(typeKit.packs).map(([value, pack]) => h("option", { value, title: pack.does }, pack.label))])
    pick.value = plan.brief.stylePack ?? ""
    return h("div", { class: "scenes" }, h("p", { class: "lead" }, "Style"), pick)
  }
  /** The film's caption look and highlight colour, on the card. */
  function captionChoice(plan, changed) {
    const looks = { clean: "Clean", karaoke: "Karaoke", boxed: "Boxed", pop: "Pop", story: "Story", minimal: "Minimal", ...(typeKit ? Object.fromEntries(typeKit.looks.map((id) => [id, MORE_LOOK_LABELS[id] ?? id])) : {}) }
    const colours = { "#ffd23f": "Yellow", "#ffb347": "Amber", "#4fd1c5": "Teal", "#ff7ab6": "Pink", "#ffffff": "White" }
    const look = h("select", { class: "field select", "aria-label": "Caption look", onchange: () => {
      plan.brief.captions = look.value
      plan.settings.captions = look.value
      changed()
    } }, Object.entries(looks).map(([value, label]) => h("option", { value }, label)))
    look.value = plan.brief.captions
    const colour = h("select", { class: "field select", "aria-label": "Highlight colour", onchange: () => {
      if (colour.value) plan.brief.captionStyle = { accent: colour.value }
      else delete plan.brief.captionStyle
      plan.settings.captionStyle = plan.brief.captionStyle
      changed()
    } }, [h("option", { value: "" }, "Look's own colour"), ...Object.entries(colours).map(([value, label]) => h("option", { value }, label))])
    colour.value = plan.brief.captionStyle?.accent ?? ""
    return h("div", { class: "scenes" }, h("p", { class: "lead" }, "Captions"), h("div", { class: "row" }, look, colour))
  }
  /**
   * The card's Order (ASSEMBLY_AND_INTENT §5): the film's parts, small, before anything renders. Each
   * part can move earlier or later right here, and Approve sends exactly the order shown.
   * Labels and file names are untrusted text: only ever textContent.
   */
  function orderStrip(plan) {
    const list = h("ol", { class: "order-strip", "aria-label": "The film's order" })
    const said = h("p", { class: "sr-only", role: "status", "aria-live": "polite" })
    const WHO = { director: "the Director's choice", default: "the order added", storyboard: "your storyboard", person: "as you said" }
    const USE = { story: "story", whole: "whole", over: "over the voice", sound: "sound only" }
    const stretch = (part) => (part.from === null && part.to === null ? (part.duration ? clock(part.duration) : "") : `${part.from === null ? "0:00" : clock(part.from)}–${part.to === null ? "end" : clock(part.to)}`)
    const draw = (focus = null) => {
      clear(list)
      const parts = plan.order.parts
      const spine = spineOf(parts)
      parts.forEach((part) => {
        const place = spine.indexOf(part)
        const label = `clip ${part.number ?? "?"}${part.label ? `, ${part.label}` : ""}`
        const move = (by, text) =>
          h("button", { type: "button", class: "btn order-move", "aria-label": `Move ${label} ${text}`, disabled: place < 0 || !spine[place + by], "data-move": `${part.id}:${by}`, onclick: () => {
            const next = movePart(plan.settings.assembly.parts, part.id, by)
            if (!next) return
            // The same move on the order shown and on the order an approval sends
            plan.settings.assembly = { version: 1, parts: next }
            plan.brief.assembly = plan.settings.assembly
            plan.order.parts = movePart(plan.order.parts, part.id, by)
            said.textContent = `${label} moved ${text}.`
            draw(`${part.id}:${by}`)
          } }, by < 0 ? "↑" : "↓")
        list.append(
          h("li", { class: "order-part", "data-part": part.id },
            h("span", { class: "order-n" }, place >= 0 ? String(place + 1) : "+"),
            h("span", { class: "order-what" }, h("b", {}, `Clip ${part.number ?? "?"}`), part.label ? ` ${part.label}` : "", h("span", { class: "note small" }, ` ${[USE[part.use] ?? part.use, stretch(part), WHO[part.why]].filter(Boolean).join(" · ")}`)),
            place >= 0 ? h("span", { class: "order-moves" }, move(-1, "earlier"), move(1, "later")) : null,
          ),
        )
      })
      if (focus) (list.querySelector(`[data-move="${focus}"]:not([disabled])`) ?? list.querySelector(`[data-part="${focus.split(":")[0]}"] button:not([disabled])`))?.focus()
    }
    draw()
    return h("div", { class: "scenes order" }, h("p", { class: "lead" }, "Order"), plan.order.parts.length ? list : null, ...plan.order.lines.map((text) => h("p", { class: "note small" }, text)), said)
  }
  // The intent frame (TP4, editing.intent): what was understood, what isn't in this cut, and open choices with a
  // default already picked. Answering is the person's; it changes this plan and isn't asked again on a revision
  function intentSection(plan, changed) {
    const { understood = [], cannot = [], questions = [], defaulted = [] } = plan.intent
    plan.intent.answers ??= {}
    const choice = (q, i) => {
      const name = `q-${plan.intent.id ?? (plan.intent.id = Math.random().toString(36).slice(2, 8))}-${i}`
      return h(
        "fieldset",
        { class: "question" },
        h("legend", {}, q.question),
        ...q.options.map((option) =>
          h("label", { class: "inline choice" }, h("input", { type: "radio", name, value: String(option), checked: option === (plan.intent.answers[q.field] ?? q.default), onchange: () => {
            plan.intent.answers[q.field] = option
            plan.settings[q.field] = option
            answerOnBrief(plan.brief, q.field, option)
            changed()
          } }), ` ${valueText(q.field, option)}${option === q.default ? " (default)" : ""}`),
        ),
      )
    }
    return h(
      "div",
      { class: "intent" },
      understood.length ? h("div", {}, h("p", { class: "lead" }, "What I understood"), h("ul", {}, understood.map((u) => h("li", {}, understoodLine(u))))) : null,
      cannot.length ? h("div", {}, h("p", { class: "lead" }, "Not in this cut"), h("ul", {}, cannot.map((c) => h("li", {}, `"${c.said}"${c.nearest ? `. Nearest I can do: ${c.nearest}` : ""}`)))) : null,
      ...questions.map(choice),
      defaulted.length ? h("p", { class: "note small" }, `Also decided by default: ${defaulted.map((d) => `${FIELD_LABELS[d.field] ?? d.field} ${valueText(d.field, d.value)}`).join(", ")}.`) : null,
    )
  }
  function planBlock(plan) {
    planGenre = plan.genreLabel ? `reads as: ${plan.genreLabel}` : null
    const line = h("p", { class: "note small plan-summary" }, settingsLine(plan.settings))
    // Each part of the plan on a tab of its own (redesign 2026-11-12): the steps first, then what the plan adds, each
    // with its count; a change on one updates the summary line and the counts. One part alone shows without tabs
    let tabs = null
    const changed = () => {
      line.textContent = settingsLine(plan.settings)
      tabs?.refresh()
    }
    const overview = [plan.steps.length ? h("ol", { class: "steps" }, plan.steps.map((step) => h("li", {}, ...withTimes(step)))) : null, plan.intent ? intentSection(plan, changed) : null, plan.order ? orderStrip(plan) : null].filter(Boolean)
    const look = [plan.brief.captions ? captionChoice(plan, changed) : null, typeKit ? styleChoice(plan) : null].filter(Boolean)
    const sections = [
      overview.length ? { key: "plan", label: "Plan", panel: h("div", { class: "plan-section" }, ...overview) } : null,
      plan.settings.scenes?.length ? { key: "scenes", label: "Scenes", panel: h("div", { class: "plan-section" }, sceneCards(plan, changed)), count: () => plan.settings.scenes?.length ?? 0 } : null,
      plan.settings.graphics?.length ? { key: "graphics", label: "Graphics", panel: h("div", { class: "plan-section" }, graphicCards(plan, changed)), count: () => plan.settings.graphics?.length ?? 0 } : null,
      plan.settings.pictures?.length ? { key: "pictures", label: "Pictures", panel: h("div", { class: "plan-section" }, pictureCards(plan, changed)), count: () => plan.settings.pictures?.length ?? 0 } : null,
      plan.settings.terms?.length ? { key: "terms", label: "Definitions", panel: h("div", { class: "plan-section" }, termCards(plan, changed)), count: () => plan.settings.terms?.length ?? 0 } : null,
      look.length ? { key: "look", label: "Look", panel: h("div", { class: "plan-section" }, ...look) } : null,
    ].filter(Boolean)
    if (sections.length > 1) tabs = createTabs(sections, { label: "Parts of the plan", className: "plan-tabs" })
    // Expand (redesign 2026-11-12): the same card, as a large sheet over the workspace, to read and adjust it at full size
    const backdrop = h("div", { class: "plan-backdrop", hidden: true, onclick: () => expand(false) })
    const expandButton = h("button", { type: "button", class: "btn ghost plan-expand", "aria-expanded": "false", onclick: () => expand(!box.classList.contains("expanded")) }, "Expand")
    const onKey = (event) => event.key === "Escape" && (event.stopPropagation(), expand(false))
    function expand(on) {
      box.classList.toggle("expanded", on)
      backdrop.hidden = !on
      expandButton.textContent = on ? "Close" : "Expand"
      expandButton.setAttribute("aria-expanded", String(on))
      if (on) {
        document.body.append(backdrop)
        box.setAttribute("role", "dialog")
        box.setAttribute("aria-modal", "true")
        box.setAttribute("aria-label", "The Director's plan")
        window.addEventListener("keydown", onKey, true)
        expandButton.focus()
      } else {
        box.removeAttribute("role")
        box.removeAttribute("aria-modal")
        box.removeAttribute("aria-label")
        backdrop.remove()
        window.removeEventListener("keydown", onKey, true)
      }
    }
    const box = h(
      "div",
      { class: "proposal plan" },
      h("div", { class: "plan-head" }, h("div", { class: "plan-title" }, h("p", { class: "lead" }, plan.revises ? "A change to your current cut, not made yet" : "The Director's plan, not made yet"), expandButton), line),
      // Worked out by Kriya's code from the plan your cut was made with and this one
      plan.revises ? h("p", { class: "note small" }, `${plan.differs?.length ? `What changes: ${plan.differs.join(" · ")}. ` : ""}${plan.keepsStory ? "The story and your own edits stay." : "The length or the trims change, so the lines are chosen again; your own edits are kept where they still fit."} Say "start over" for a new cut from the footage.`) : null,
      ...(tabs ? [tabs.strip] : []),
      ...sections.map((section) => section.panel),
      h(
        "div",
        { class: "row plan-actions" },
        h("button", { type: "button", class: "btn primary", onclick: () => (expand(false), (pendingPlan = null), showPlanInPanel(plan.brief), clear(box).append(h("p", { class: "note" }, `Approved. Making it now in ${plan.brief.format ?? makeFormat.value}; the progress is in Brief.`)), make(plan.brief, { exact: true, plan }), showTab("brief")) }, "Approve and make it"),
        h("button", { type: "button", class: "btn", onclick: () => (expand(false), (pendingPlan = plan), prompt.focus(), (prompt.placeholder = "Say what to change in the plan…")) }, "Change…"),
      ),
    )
    return box
  }
  /** An approved plan sets the Direct panel, so its controls show what's being made (found in use: they kept their old values) */
  function showPlanInPanel(brief = {}) {
    if (brief.format) makeFormat.value = brief.format
    const length = brief.seconds ? String(brief.seconds) : ""
    if (length && ![...makeLength.options].some((o) => o.value === length)) makeLength.append(h("option", { value: length }, `${length} seconds`))
    makeLength.value = length
    makeCaptions.value = brief.captions ?? ""
    makeGrade.value = brief.grade ?? ""
    lookCards?.mark()
    if (/^generated:/.test(brief.music ?? "") && [...makeMusic.options].some((o) => o.value === brief.music)) makeMusic.value = brief.music
    else if (!brief.music) makeMusic.value = ""
    makeVoice.value = brief.cleanVoice ? "clean" : ""
    makeAngles.box.checked = !!brief.angles
    makeBroll.box.checked = brief.broll === "own"
    makeTitles.box.checked = !!brief.titles
    makeTemplate.value = ""
  }
  async function askPlan(text, previous = null, pointing = {}) {
    showTab("chat")
    const thinking = message("kriya", previous ? "Revising the plan…" : "Planning the cut…")
    try {
      const plan = await api("POST", `/projects/${id}/plan`, { text, history: history.slice(-6), previous, choices: choicesNow(), ...pointing })
      thinking.remove()
      pendingPlan = plan
      message("kriya", plan.say || "Here's my plan.", planBlock(plan))
      history.push({ who: "kriya", text: (plan.say || "").slice(0, 400) })
    } catch (error) {
      thinking.remove()
      message("kriya", error.message)
    }
  }
  async function send({ planning = false } = {}) {
    const typed = prompt.value.trim()
    if (!typed) return
    showTab("chat")
    // The message as typed is what the chat shows; what's sent has each mention as a numbered place and a typed list
    const taken = mentionBox ? mentionBox.take(typed) : { text: typed, mentions: [] }
    const text = taken.text
    // TP9: a drawn box goes with this message as "this", once
    const drawn = drawing?.mark()
    const pointing = { ...(taken.mentions.length ? { mentions: taken.mentions } : {}), ...(drawn ? { mark: drawn } : {}) }
    if (drawn) drawing.clear()
    prompt.placeholder = assemblyOn ? "Tell Kriya what to change. Type @ to point at a clip." : "Tell Kriya: \"remove 0:05 to 0:09\", \"change the caption at 0:12 to …\", \"make the start punchier\""
    // Talking about the plan: revise it; asking for a plan: plan
    if (pendingPlan || planning) {
      message("you", typed)
      history.push({ who: "you", text: typed.slice(0, 400) })
      prompt.value = ""
      return askPlan(text, pendingPlan, pointing)
    }
    const { selection, label } = selectionNow()
    message("you", drawn ? `${typed}  (on the ${drawn.kind} you drew at ${clock(drawn.at)})` : label ? `${typed}  (${label.replace(/^Selected: /, "on ")})` : typed)
    prompt.value = ""
    const thinking = message("kriya", "Thinking about that…")
    try {
      const reply = await api("POST", `/projects/${id}/ask`, { text, selection, history: history.slice(-6), ...pointing })
      thinking.remove()
      const words = reply.say || (reply.proposal ? "Here's what I'd change." : reply.direct ? "That's about the whole video." : (reply.reason ?? "I couldn't turn that into an edit. Try saying it another way."))
      history.push({ who: "you", text: typed.slice(0, 400) })
      if (reply.proposal?.motion) reply.proposal.ask = text
      // A request about the whole video: the Director pitches a plan for approval
      if (reply.direct && !reply.proposal) return askPlan(text, null, pointing)
      // TP4: what the change couldn't do, in the person's own words, never left unsaid
      const cannot = reply.cannot?.length ? h("div", { class: "intent" }, h("p", { class: "lead" }, "Not in this change"), h("ul", {}, reply.cannot.map((c) => h("li", {}, `"${c.said}"${c.nearest ? `. Nearest I can do: ${c.nearest}` : ""}`)))) : null
      message("kriya", words, reply.proposal ? proposalBlock(reply.proposal) : null, cannot)
      history.push({ who: "kriya", text: words.slice(0, 400) })
    } catch (error) {
      thinking.remove()
      message("kriya", error.status === 0 || error.status >= 500 ? "I can't reach Kriya right now, so I can't make changes by asking. You can still edit by hand." : error.message)
    }
  }
  prompt.addEventListener("keydown", (event) => {
    // Enter sends; Shift+Enter is a new line
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) (event.preventDefault(), send())
  })
  const promptForm = h(
    "form",
    { class: "prompt", onsubmit: (event) => (event.preventDefault(), send()) },
    h("label", { for: "prompt", class: "sr-only" }, "Message Kriya"),
    prompt,
    h("div", { class: "send" }, h("button", { class: "btn primary", type: "submit" }, "Send"), h("button", { type: "button", class: "btn", title: "Ask the Director for a plan of the whole cut", onclick: () => send({ planning: true }) }, "Plan"), ...(view.dictation ? [holdToTalk()] : [])),
  )
  /* Hold to talk (TP4, §7.4): only when this computer has the recogniser's weights. The recording goes to this
     Studio's own Host and becomes text in the box, which the person reads before sending; no speech service is used */
  function holdToTalk() {
    const button = h("button", { type: "button", class: "btn talk", "aria-pressed": "false", title: "Hold to talk (or hold Space on this button); the text appears in the box" }, "Hold to talk")
    let recorder = null
    let stream = null
    let started = 0
    const start = async () => {
      if (recorder) return
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      } catch {
        say.textContent = "The microphone isn't available to the Studio."
        return
      }
      const chunks = []
      recorder = new MediaRecorder(stream)
      recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data)
      recorder.onstop = async () => {
        for (const track of stream.getTracks()) track.stop()
        const type = (recorder.mimeType || "audio/webm").split(";")[0]
        recorder = null
        button.setAttribute("aria-pressed", "false")
        button.textContent = "Hold to talk"
        if (Date.now() - started < 300 || !chunks.length) return (say.textContent = "Hold the button while you speak.")
        say.textContent = "Turning your words into text on this computer…"
        try {
          const response = await fetch(`/projects/${id}/dictate`, { method: "POST", headers: { "content-type": type }, body: new Blob(chunks, { type }) })
          const answer = await response.json()
          if (!response.ok) throw new Error(answer.message ?? "That couldn't be heard.")
          prompt.value = `${prompt.value ? `${prompt.value} ` : ""}${answer.text}`.trim()
          say.textContent = answer.text ? "Read it over, then send." : "Nothing was heard."
          prompt.focus()
        } catch (error) {
          say.textContent = error.message
        }
      }
      started = Date.now()
      recorder.start()
      button.setAttribute("aria-pressed", "true")
      button.textContent = "Listening… let go to stop"
      // A minute at most
      setTimeout(() => recorder?.state === "recording" && recorder.stop(), 60_000)
    }
    const stop = () => recorder?.state === "recording" && recorder.stop()
    button.addEventListener("pointerdown", (event) => (event.preventDefault(), start()))
    for (const name of ["pointerup", "pointerleave", "pointercancel"]) button.addEventListener(name, stop)
    button.addEventListener("keydown", (event) => (event.key === " " || event.key === "Enter") && !event.repeat && (event.preventDefault(), start()))
    button.addEventListener("keyup", (event) => (event.key === " " || event.key === "Enter") && stop())
    return button
  }
  const markButtons = h(
    "div",
    { class: "marks", role: "group", "aria-label": "Mark a range of the cut" },
    h("button", { type: "button", class: "btn", "aria-keyshortcuts": "I", title: "Mark in (I)", onclick: () => act({ type: "mark", edge: "in" }) }, "Mark in"),
    h("button", { type: "button", class: "btn", "aria-keyshortcuts": "O", title: "Mark out (O)", onclick: () => act({ type: "mark", edge: "out" }) }, "Mark out"),
  )
  const verdictWords = { delivered: "Checked", delivered_with_notes: "Checked, with notes", blocked: "Needs you", needs_you: "Needs you", not_checked: "Not checked" }
  // What the Director makes: the length, captions, music and a style reference, all optional
  const makeLength = h("select", { id: "make-length", class: "field select" }, [["", "Length: auto (30–60 s)"], ["30", "30 seconds"], ["45", "45 seconds"], ["60", "60 seconds"], ["90", "90 seconds"]].map(([value, label]) => h("option", { value }, label)))
  const makeCaptions = h("select", { id: "make-captions", class: "field select" }, [["", "No captions"], ["clean", "Captions: clean"], ["karaoke", "Captions: karaoke"], ["boxed", "Captions: boxed"], ["pop", "Captions: pop"], ["story", "Captions: story"], ["minimal", "Captions: minimal"]].map(([value, label]) => h("option", { value }, label)))
  if (typeKit) makeCaptions.append(...typeKit.looks.map((value) => h("option", { value }, `Captions: ${(MORE_LOOK_LABELS[value] ?? value).toLowerCase()}`)))
  const makeMusic = h("select", { id: "make-music", class: "field select" })
  // TP7: a style pack fills what the selects leave open; the type kit, colours, logo and bar are the person's own
  const makeStyle = typeKit ? h("select", { id: "make-style", class: "field select" }, [h("option", { value: "" }, "Style: none"), ...Object.entries(typeKit.packs).map(([value, pack]) => h("option", { value, title: pack.does }, `Style: ${pack.label}`))]) : null
  const makeType = typeKit ? h("select", { id: "make-type", class: "field select" }, [h("option", { value: "" }, "Type: the film's own"), ...Object.entries(typeKit.pairs).map(([value, label]) => h("option", { value }, `Type: ${label}`))]) : null
  const makeBar = typeKit ? h("select", { id: "make-bar", class: "field select" }, [["", "Bar: none"], ["progress", "Bar: progress"], ["chapters", "Bar: chapters"]].map(([value, label]) => h("option", { value }, label))) : null
  const makeLogo = typeKit ? h("select", { id: "make-logo", class: "field select" }) : null
  const colourIn = (idName, label) => {
    const on = h("input", { type: "checkbox", id: `${idName}-on` })
    const pick = h("input", { type: "color", id: idName, class: "swatch", value: idName === "make-ink" ? "#ffffff" : "#ffd23f", "aria-label": label })
    return { on, pick, el: h("label", { class: "inline", for: `${idName}-on` }, on, ` ${label} `, pick) }
  }
  const makeInk = typeKit ? colourIn("make-ink", "My text colour") : null
  const makeAccent = typeKit ? colourIn("make-accent", "My accent") : null
  const typeNote = typeKit && !typeKit.shipped ? h("p", { class: "note" }, "The Fonts pack isn't installed on this computer, so a type kit draws in the system fonts until it is (kriya edit setup --pack fonts).") : null
  const typeKitNow = () => {
    if (!typeKit) return {}
    // A pack brings its own pair; with none, the film's chosen pair, or Clean, carries the colours, logo and bar
    const pair = makeType.value || (makeStyle.value ? null : (typeKit.chosen?.pair ?? "clean"))
    const colors = { ...(makeInk.on.checked ? { text: makeInk.pick.value } : {}), ...(makeAccent.on.checked ? { accent: makeAccent.pick.value } : {}) }
    const extras = { ...(Object.keys(colors).length ? { colors } : {}), ...(makeLogo.value ? { logo: makeLogo.value } : {}), ...(makeBar.value ? { bar: makeBar.value } : {}) }
    return {
      ...(makeStyle.value ? { stylePack: makeStyle.value } : {}),
      // A type kit only when one is chosen here: the film's own stays as it is (EH-69)
      ...(makeType.value || Object.keys(extras).length ? { typeKit: { ...(pair ? { pair } : {}), ...extras } } : {}),
    }
  }
  const makeFormat = h("select", { id: "make-format", class: "field select" }, [["9:16", "Format: 9:16 (Reels, Shorts)"], ["16:9", "Format: 16:9 (YouTube)"], ["1:1", "Format: 1:1 (square post)"], ["4:5", "Format: 4:5 (feed post)"]].map(([value, label]) => h("option", { value }, label)))
  const makeGrade = h("select", { id: "make-grade", class: "field select" }, [["", "Look: natural"], ["vivid", "Look: vivid"], ["cinematic", "Look: cinematic (cool, vignette)"], ["warm", "Look: warm"], ["bright", "Look: bright"], ["mono", "Look: black and white"]].map(([value, label]) => h("option", { value }, label)))
  const makeVoice = h("select", { id: "make-voice", class: "field select" }, [["", "Voice: as recorded"], ["clean", "Voice: remove background noise"]].map(([value, label]) => h("option", { value }, label)))
  // Extras: one camera cut like two, the person's other clips as B-roll, key words as title cards
  const extra = (idName, label) => {
    const box = h("input", { type: "checkbox", id: idName })
    return { box, el: h("label", { class: "inline", for: idName }, box, ` ${label}`) }
  }
  const makeAngles = extra("make-angles", "Angles (wide and tight)")
  const makeBroll = extra("make-broll", "B-roll from my clips")
  const makeTitles = extra("make-titles", "Title cards")
  let musicChoice = ""
  makeMusic.addEventListener("change", () => (musicChoice = makeMusic.value))
  // Templates: a starting point for the selects below them, each still yours to change
  const TEMPLATES = {
    "": null,
    reel: { format: "9:16", captions: "karaoke", grade: "vivid", length: "45", music: "generated:upbeat", voice: "clean", angles: true },
    clean: { format: "9:16", captions: "clean", grade: "", length: "30", music: "", voice: "clean" },
    youtube: { format: "16:9", captions: "clean", grade: "warm", length: "60", music: "generated:calm", voice: "clean" },
    square: { format: "1:1", captions: "boxed", grade: "vivid", length: "30", music: "generated:upbeat", voice: "clean" },
    cinematic: { format: "16:9", captions: "", grade: "cinematic", length: "60", music: "generated:warm", voice: "clean", angles: true, titles: true },
  }
  const makeTemplate = h(
    "select",
    {
      id: "make-template",
      class: "field select",
      onchange: () => {
        const t = TEMPLATES[makeTemplate.value]
        if (!t) return
        makeFormat.value = t.format
        makeCaptions.value = t.captions
        makeGrade.value = t.grade
        makeLength.value = t.length
        makeVoice.value = t.voice
        makeAngles.box.checked = !!t.angles
        makeTitles.box.checked = !!t.titles
        makeMusic.value = musicChoice = t.music
      },
    },
    [["", "Template: choose…"], ["reel", "Talking-head reel: karaoke captions, upbeat music"], ["clean", "Clean reel: simple captions, no music"], ["youtube", "YouTube talk: 16:9, warm, calm music"], ["square", "Square post: boxed captions, vivid"], ["cinematic", "Cinematic: 16:9, cool look, no captions"]].map(([value, label]) => h("option", { value }, label)),
  )
  const showRefSummary = () => {
    const inUse = assets.filter((a) => a.kind === "reference" && using.has(a.id))
    const fors = [...new Set(inUse.map((a) => aspectOf(a.id)))].map((a) => (a === "all" ? "everything" : ASPECT[a].split(":")[0].toLowerCase()))
    refSummary.textContent = inUse.length ? `${inUse.length} reference${inUse.length === 1 ? "" : "s"} in use, for ${fors.join(", ")}.` : "No references in use."
  }
  const briefNow = (extra = {}) => ({
    ...(makeLength.value ? { seconds: Number(makeLength.value) } : {}),
    ...(makeCaptions.value ? { captions: makeCaptions.value } : {}),
    ...(makeMusic.value ? { music: makeMusic.value } : {}),
    ...(using.size ? { references: [...using].filter((rid) => assets.some((a) => a.id === rid && a.kind === "reference")).map((rid) => ({ id: rid, aspect: aspectOf(rid) })) } : {}),
    format: makeFormat.value,
    ...(makeGrade.value ? { grade: makeGrade.value } : {}),
    ...(makeVoice.value === "clean" ? { cleanVoice: true } : {}),
    ...(makeAngles.box.checked ? { angles: true } : {}),
    ...(makeBroll.box.checked ? { broll: "own" } : {}),
    ...(makeTitles.box.checked ? { titles: true } : {}),
    ...typeKitNow(),
    ...styleNow(),
    // TP8: the opening the person picked on the Variations wall, as the make's hook
    ...(directorLoop && chosenOpening ? { hook: chosenOpening, mustKeep: [chosenOpening] } : {}),
    ...extra,
  })
  /** exact: the brief as given (an approved plan) plus the references in use; else the panel's choices under it */
  async function make(extra, { exact = false, plan = null } = {}) {
    try {
      const refs = briefNow().references
      const job = await api("POST", `/projects/${id}/make`, { brief: exact ? { ...extra, ...(refs ? { references: refs } : {}), ...styleNow() } : { ...briefNow(extra), ...(assemblyOn && partsOf(project).length ? { assembly: { version: 1, parts: partsOf(project) } } : {}) }, ...(plan ? { plan: { say: plan.say, steps: plan.steps, settings: plan.settings } } : {}) })
      makeJob = job.id
      jobsNow.set(job.id, job)
      if (liveOn) (buildStrip.reset(), (stripUsed = true), takeEarly())
      say.textContent = "Directing your reel: reading the footage, choosing the story, cutting and checking it. You can keep working."
      showMake()
    } catch (error) {
      say.textContent = error.message
    }
  }
  const makeButton = h("button", { type: "button", class: "btn primary wide", onclick: () => make() }, "Make it")
  const makeStatus = h("div", { class: "make-status", "aria-live": "polite" })
  function showMake() {
    const job = makeJob ? jobsNow.get(makeJob) : null
    clear(makeStatus)
    makeButton.disabled = !!job
    if (replayButton) replayButton.disabled = !!job
    // editing.livePreview: the Director Build Strip in place of the bare percentage; it stays after the make, finished
    if (job && liveOn) makeStatus.append(buildStrip.el, progressBar(job.progress ?? 0, "Making the reel"))
    else if (job) makeStatus.append(h("p", { class: "note" }, `Making the reel… ${job.progress ?? 0}%`), progressBar(job.progress ?? 0, "Making the reel"))
    else if (liveOn && stripUsed) makeStatus.append(buildStrip.el)
  }

  /* "Watch the Director edit" (editing.livePreview). Off, none of this is made and nothing listens */
  let directorShowing = false // the monitor shows the Director's working cut, not the person's
  let lastLive = null // the latest live view the Host sent for this make
  let pendingLive = null // a view that arrived while the cut was playing: shown when it stops
  let stripUsed = false
  let proposalGhost = null // a proposal's ghost on the timeline, which a live view mustn't wipe
  const buildStrip = liveOn ? createDirectorStrip({ onFollow: (follow) => (follow ? lastLive && showLive(lastLive) : restoreCut()) }) : null
  const replay = liveOn
    ? createReplay({
        load: () => api("GET", `/projects/${id}/layers`),
        show: (layer) => showView(layer, `Replay: ${layer.label}`),
        restore: () => restoreCut(),
        animate: shouldAnimate({ reduced: matchMedia("(prefers-reduced-motion: reduce)").matches, automated: navigator.webdriver === true }),
      })
    : null
  const replayButton = liveOn ? h("button", { type: "button", class: "btn replay-open", title: "Watch the latest make build up layer by layer, from the raw footage to the mix. Nothing renders.", onclick: () => (directorShowing ? null : replay.start()) }, "Replay how it was edited") : null
  /** A preview plan and its timeline on the monitor, with the badge saying whose cut it is. */
  async function showView(view, label) {
    if (!view?.preview || !view?.timeline) return
    directorBadge.textContent = label
    directorBadge.hidden = false
    if (!proposalGhost) (timeline.setGhost(view.timeline), strip.setGhost(view.timeline))
    if (source) return
    const next = programOf(view.timeline)
    await monitor.load(next, { fps: fps(), duration: durationOf(next), shape: shapeNow(), preview: view.preview })
  }
  function showLive(view) {
    directorShowing = true
    return showView(view, "Director working preview")
  }
  // A live view, unless the person is playing their cut: then when it stops
  function liveSoon() {
    if (!pendingLive || monitor.rate !== 0 || replay?.open || !buildStrip?.follow) return
    const view = pendingLive
    pendingLive = null
    void showLive(view)
  }
  /** Back to the person's own cut on the monitor and timeline. */
  async function restoreCut() {
    directorShowing = false
    pendingLive = null
    if (directorBadge) directorBadge.hidden = true
    timeline.setGhost(proposalGhost)
    strip.setGhost(proposalGhost)
    if (!source) await monitor.load(pieces, withPreview({ fps: fps(), duration: durationOf(pieces), shape: shapeNow() }))
  }
  // A fast make can send its first events before this page has its job id back: they wait here, for this project only
  let earlyLive = []
  function onLiveEvent(event) {
    let data = null
    try {
      data = JSON.parse(event.data)
    } catch {}
    if (!data || data.project !== id) return
    if (makeJob === null) return void (earlyLive = [...earlyLive, data].slice(-40))
    takeLive(data)
  }
  /** The job id is known: the events that came first, then nothing more is held. */
  function takeEarly() {
    const held = earlyLive
    earlyLive = []
    for (const data of held) takeLive(data)
  }
  function takeLive(data) {
    if (data.job !== makeJob) return
    stripUsed = true
    buildStrip.push(data)
    if (data.preview && data.timeline) {
      lastLive = data
      pendingLive = data
      if (buildStrip.follow) liveSoon()
    }
  }
  /** The make ended: the strip stays as it finished; the reload that follows brings the cut back. */
  function endDirector() {
    buildStrip.finish()
    directorShowing = false
    lastLive = pendingLive = null
    if (directorBadge) directorBadge.hidden = true
    timeline.setGhost(proposalGhost)
    strip.setGhost(proposalGhost)
  }
  // TP8 (editing.directorLoop, as this Kriya says): three openings to choose from. Off, none of it is on the page
  const directorLoop = view.directorLoop === true
  let chosenOpening = null
  let openings = { status: "none" }
  const openingsEl = h("div", { class: "openings-host" })
  function showOpenings() {
    if (!directorLoop) return
    clear(openingsEl).append(variationsWall({ project: id, state: openings, chosen: chosenOpening, onAsk: askOpenings, onChoose: (hook) => ((chosenOpening = hook), showOpenings()) }))
  }
  async function askOpenings() {
    try {
      const job = await api("POST", `/projects/${id}/openings`, { brief: { format: makeFormat.value, ...(makeCaptions.value ? { captions: makeCaptions.value } : {}), ...(makeGrade.value ? { grade: makeGrade.value } : {}) } })
      openings = { status: "making", job: job.id, progress: 0 }
      chosenOpening = null
    } catch (error) {
      openings = { status: "failed", error: error.message }
    }
    showOpenings()
  }
  async function openingsProgress() {
    if (openings.status !== "making") return
    const job = (await api("GET", "/jobs")).jobs.find((j) => j.id === openings.job)
    if (!job) return
    if (job.status === "done") openings = { status: "ready", job: job.id, openings: JSON.parse(job.output).openings }
    else if (["failed", "canceled"].includes(job.status)) openings = { status: "failed", error: job.error ?? "the drafts stopped" }
    else openings = { ...openings, progress: job.progress ?? 0 }
    showOpenings()
  }
  showOpenings()
  // The Brief (redesign 2026-11-12): the same controls, grouped by what they decide, two to a row where the
  // panel is wide enough; Make it stays in reach at the bottom of the panel however far the groups scroll
  // editing.livePreview: each colour look drawn on a frame of the person's own footage, beside the select
  const lookCards = liveOn
    ? createLookCards({
        select: makeGrade,
        source: () => {
          const take = assets.find((a) => a.kind === "video" && !a.offline && a.facts?.duration)
          return take ? { url: `/tiles/${take.media}?kind=thumbs`, cell: sheetCell(take.facts.duration / 705_600_000) } : null
        },
      })
    : null
  if (lookCards) makeTemplate.addEventListener("change", () => lookCards.mark())
  const briefGroup = (title, ...rows) => h("section", { class: "brief-group", "aria-label": title }, h("h3", { class: "group-title" }, title), ...rows)
  const briefPair = (...fields) => h("div", { class: "brief-pair" }, ...fields)
  const makePanel = h(
    "div",
    { class: "make" },
    briefGroup("Start from", h("label", { for: "make-template", class: "sr-only" }, "Template"), makeTemplate),
    briefGroup("Shape", briefPair(h("div", {}, h("label", { for: "make-format", class: "sr-only" }, "Format"), makeFormat), h("div", {}, h("label", { for: "make-length", class: "sr-only" }, "Length"), makeLength))),
    briefGroup(
      "Look and sound",
      ...(lookCards ? [lookCards.el] : []),
      briefPair(h("div", {}, h("label", { for: "make-captions", class: "sr-only" }, "Captions"), makeCaptions), h("div", {}, h("label", { for: "make-grade", class: "sr-only" }, "Colour look"), makeGrade)),
      briefPair(h("div", {}, h("label", { for: "make-music", class: "sr-only" }, "Music"), makeMusic), h("div", {}, h("label", { for: "make-voice", class: "sr-only" }, "Voice"), makeVoice)),
    ),
    briefGroup("Extras", h("div", { class: "extras toggles", role: "group", "aria-label": "Extras" }, makeAngles.el, makeBroll.el, makeTitles.el)),
    ...(typeKit
      ? [
          briefGroup(
            "Brand",
            briefPair(h("div", {}, h("label", { for: "make-style", class: "sr-only" }, "Style pack"), makeStyle), h("div", {}, h("label", { for: "make-type", class: "sr-only" }, "Type kit"), makeType)),
            h("div", { class: "extras toggles", role: "group", "aria-label": "Brand colours" }, makeInk.el, makeAccent.el),
            briefPair(h("div", {}, h("label", { for: "make-logo", class: "sr-only" }, "Logo"), makeLogo), h("div", {}, h("label", { for: "make-bar", class: "sr-only" }, "Bar across the film"), makeBar)),
            ...(typeNote ? [typeNote] : []),
          ),
        ]
      : []),
    briefGroup("References", refSummary, directRefsEl, h("div", { class: "row tight" }, refPicker, addAspect, h("button", { type: "button", class: "btn", "aria-label": "Add a reference", title: "Add a reference for what's chosen: a video, an image or music", onclick: () => refPicker.click() }, "+ Reference"))),
    ...(directorLoop ? [briefGroup("Openings", openingsEl)] : []),
    h("div", { class: "make-footer" }, ...(liveOn ? [h("div", { class: "make-row" }, makeButton, replayButton)] : [makeButton]), makeStatus),
  )
  let makeJob = null
  async function makeProgress() {
    if (!makeJob) return
    const job = (await api("GET", "/jobs")).jobs.find((j) => j.id === makeJob)
    if (job) jobsNow.set(job.id, job)
    showMake()
    if (!job || !["done", "failed", "canceled"].includes(job.status)) return
    makeJob = null
    showMake()
    if (job.status !== "done") return (say.textContent = job.error ?? "The reel stopped.")
    const result = JSON.parse(job.output)
    say.textContent = `${verdictWords[result.verdict] ?? result.verdict}. ${result.notes.join(" ")}`
    if (result.file) did.prepend(h("li", { class: "watch" }, h("button", { type: "button", class: "btn primary", onclick: () => setMode("finish") }, "Watch the final cut")))
    for (const change of [...result.changes].reverse()) did.prepend(h("li", {}, change))
  }

  /* transport */
  const play = h("button", { type: "button", class: "btn primary", onclick: () => act({ type: "toggle" }) }, "Play")
  const shape = h("select", { class: "field small select", "aria-label": "Preview shape", onchange: () => monitor.setShape(shapeNow()) }, ["project", "16:9", "9:16"].map((value) => h("option", { value }, value === "project" ? "Project shape" : value)))
  const zoom = h("input", { type: "range", min: "1", max: "3", step: "0.05", value: "1", class: "zoom", "aria-label": "Zoom", oninput: () => monitor.setZoom(Number(zoom.value)) })
  const guides = h("input", { type: "checkbox", id: "guides", onchange: () => monitor.setGuides(guides.checked) })
  const shortcuts = liveOn ? createShortcuts() : null
  const monitorFrame = h("div", { class: `monitor-frame${liveOn ? " live" : ""}` }, canvas, directorBadge)
  // Compare (editing.livePreview): a handle over the monitor, the raw footage left of it and the cut right of it
  let compareAt = 0.5
  const wipeGrip = liveOn ? h("span", { class: "wipe-grip", role: "slider", tabindex: "0", "aria-label": "Compare: raw footage on the left, your cut on the right", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": "50" }) : null
  const wipe = liveOn ? h("div", { class: "wipe", hidden: true }, h("span", { class: "wipe-tag raw" }, "Raw"), h("span", { class: "wipe-tag cut" }, "Cut"), h("span", { class: "wipe-line" }, wipeGrip)) : null
  const compareButton = liveOn ? h("button", { type: "button", class: "btn small compare", "aria-pressed": "false", title: "Drag the handle across the picture: raw footage on one side, your cut on the other", onclick: () => setCompare(wipe.hidden) }, "Compare raw") : null
  function placeWipe() {
    if (!wipe || wipe.hidden) return
    Object.assign(wipe.style, { left: `${canvas.offsetLeft}px`, top: `${canvas.offsetTop}px`, width: `${canvas.clientWidth}px`, height: `${canvas.clientHeight}px` })
    wipe.querySelector(".wipe-line").style.left = `${(compareAt * 100).toFixed(2)}%`
    wipeGrip.setAttribute("aria-valuenow", String(Math.round(compareAt * 100)))
  }
  function setCompare(on, at = compareAt) {
    compareAt = Math.min(1, Math.max(0, at))
    wipe.hidden = !on
    compareButton.setAttribute("aria-pressed", String(on))
    placeWipe()
    return monitor.setWipe(on ? compareAt : null)
  }
  if (wipe) {
    monitorFrame.append(wipe)
    new ResizeObserver(placeWipe).observe(canvas)
    const fromPointer = (event) => {
      const rect = canvas.getBoundingClientRect()
      return setCompare(true, (event.clientX - rect.left) / rect.width)
    }
    wipeGrip.addEventListener("pointerdown", (event) => {
      event.preventDefault()
      event.stopPropagation()
      wipeGrip.setPointerCapture(event.pointerId)
      const move = (e) => fromPointer(e)
      const up = () => (wipeGrip.removeEventListener("pointermove", move), wipeGrip.removeEventListener("pointerup", up), wipeGrip.removeEventListener("pointercancel", up))
      wipeGrip.addEventListener("pointermove", move)
      wipeGrip.addEventListener("pointerup", up)
      wipeGrip.addEventListener("pointercancel", up)
    })
    wipeGrip.addEventListener("keydown", (event) => {
      const by = { ArrowLeft: -0.05, ArrowRight: 0.05 }[event.key]
      const to = event.key === "Home" ? 0 : event.key === "End" ? 1 : by === undefined ? null : compareAt + by
      if (to === null) return
      event.preventDefault()
      event.stopPropagation()
      setCompare(true, to)
    })
  }
  const drawing = customOn
    ? createDrawing({
        frame: monitorFrame,
        canvas,
        timeNow: () => monitor.time,
        zoomNow: () => Number(zoom.value),
        // The box is in thousandths of the cut's own frame, so it is drawn on the cut, in the project's shape
        usable: () => (source ? "Drawing marks the cut: show the cut on the monitor first." : shape.value !== "project" ? "Drawing marks the project's own frame: set the preview shape back to Project shape." : null),
        pause: () => monitor.rate !== 0 && act({ type: "toggle" }),
        onChange: () => {},
      })
    : null
  if (drawing) zoom.addEventListener("input", () => drawing.redraw())

  function act(action) {
    if (!action) return
    if (action.type === "mode") return setMode(action.mode)
    if (action.type === "prompt") return prompt.focus()
    // Marks are on the cut's own timeline: in, then out; a new in starts over
    if (action.type === "mark") {
      showProgram()
      if (action.edge === "in" || markIn === null) ((markIn = monitor.time), (markOut = null))
      else if (monitor.time > markIn) markOut = monitor.time
      else ((markOut = markIn), (markIn = monitor.time))
      say.textContent = markOut === null ? `Marked in at ${clock(markIn)}. Play to the end of the stretch and press O.` : `Marked ${clock(markIn)} to ${clock(markOut)}. Tell Kriya what to do with it.`
      return showChip()
    }
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

  /* The Kriya panel's width: it fits the window by itself, and the person can drag its edge
     (or use the arrow keys on it) to make room for the chat; double-click goes back to fitting */
  const SIDE = { min: 300, step: 32 }
  const sideMax = () => Math.max(SIDE.min, Math.min(960, Math.round(window.innerWidth * 0.62)))
  const sideNow = () => document.querySelector(".area-kriya")?.getBoundingClientRect().width ?? 0
  function setSide(px) {
    if (px === null) {
      root.style.removeProperty("--side")
      remember("kriya-side-width", "")
    } else {
      const width = Math.round(Math.min(sideMax(), Math.max(SIDE.min, px)))
      root.style.setProperty("--side", `${width}px`)
      remember("kriya-side-width", String(width))
    }
    sideHandle.setAttribute("aria-valuenow", String(Math.round(sideNow())))
    timeline.draw()
    strip.draw()
  }
  const sideHandle = h("div", {
    class: "side-handle",
    role: "separator",
    tabindex: "0",
    "aria-orientation": "vertical",
    "aria-label": "Resize the Kriya panel",
    "aria-valuemin": String(SIDE.min),
    title: "Drag to resize. Double-click to fit the window.",
    onpointerdown: (event) => {
      event.preventDefault()
      sideHandle.setPointerCapture(event.pointerId)
      const right = document.querySelector(".area-kriya").getBoundingClientRect().right
      const move = (e) => setSide(right - e.clientX)
      const up = () => (sideHandle.removeEventListener("pointermove", move), sideHandle.removeEventListener("pointerup", up), sideHandle.removeEventListener("pointercancel", up))
      sideHandle.addEventListener("pointermove", move)
      sideHandle.addEventListener("pointerup", up)
      sideHandle.addEventListener("pointercancel", up)
    },
    ondblclick: () => setSide(null),
    onkeydown: (event) => {
      const by = { ArrowLeft: SIDE.step, ArrowRight: -SIDE.step }[event.key]
      if (by) (event.preventDefault(), event.stopPropagation(), setSide(sideNow() + by))
      else if (event.key === "Home") (event.preventDefault(), setSide(null))
    },
  })
  /* The Kriya panel (redesign 2026-11-12): Brief, Chat and Activity as tabs over one docked panel, each scrolling on its
     own, so the brief, a long Plan Card and the list of what was done no longer stack into one long column */
  const briefPanel = h("div", { class: "brief-panel" }, makePanel)
  // Ideas, worded so none reads like a button of its own (Plan, Send, Remove, Make it, Accept)
  const SUGGESTIONS = ["A 30 second reel from this", "Cut the false starts", "A punchier start", "A name strap with my name and role"]
  const chatEmpty = h(
    "div",
    { class: "chat-empty" },
    h("p", { class: "empty-title" }, "Tell Kriya what you want"),
    h("p", { class: "note small" }, "A change to this cut, or a plan for the whole film. Times like 0:05, a marked stretch or selected words are \"this\"."),
    h("div", { class: "suggestions", role: "group", "aria-label": "Ideas to start from" }, SUGGESTIONS.map((text) => h("button", { type: "button", class: "btn suggestion", onclick: () => ((prompt.value = text), prompt.focus()) }, text))),
  )
  const chatPanel = h(
    "div",
    { class: "chat-panel" },
    h("div", { class: "chat-scroll" }, chatEmpty, chatEl),
    h("div", { class: "composer" }, chip, mentionThis, mentionBox?.el, promptForm, h("p", { class: "note small hint" }, "Enter sends. Shift+Enter is a new line. Mark a stretch with I and O.")),
  )
  const activityPanel = h("div", { class: "activity-panel" }, h("p", { class: "note small activity-empty" }, "Nothing yet. Changes you accept and the cuts Kriya makes are listed here, newest first."), did)
  const inspector = createTabs(
    [
      { key: "brief", label: "Brief", panel: briefPanel },
      { key: "chat", label: "Chat", panel: chatPanel },
      { key: "activity", label: "Activity", panel: activityPanel, count: () => did.children.length || null },
    ],
    { label: "Kriya", selected: ["brief", "chat", "activity"].includes(remember("kriya-tab")) ? remember("kriya-tab") : "chat", className: "inspector-tabs", onSelect: (key) => remember("kriya-tab", key) },
  )
  showTab = (key) => inspector.select(key)
  // Something new on a tab that isn't showing: a badge on it, until it's opened
  let unread = 0
  const chatEmptyNow = () => (chatEmpty.hidden = chatEl.children.length > 0)
  new MutationObserver((records) => {
    chatEmptyNow()
    const fresh = records.flatMap((r) => [...r.addedNodes]).filter((n) => n.classList?.contains("kriya")).length
    if (inspector.selected() === "chat") unread = 0
    else if (fresh) inspector.mark("chat", (unread += fresh))
  }).observe(chatEl, { childList: true })
  chatEmptyNow()
  let seenDone = did.children.length
  new MutationObserver(() => {
    inspector.refresh()
    const fresh = did.children.length - seenDone
    if (inspector.selected() === "activity") seenDone = did.children.length
    else if (fresh > 0) inspector.mark("activity", fresh)
  }).observe(did, { childList: true })
  const watchTabs = inspector.strip
  watchTabs.addEventListener("click", () => {
    if (inspector.selected() === "chat") unread = 0
    if (inspector.selected() === "activity") seenDone = did.children.length
  })
  const root = h(
    "div",
    { class: "workspace" },
    topBar(h("span", { class: "project-name" }, project.name), modeButtons),
    // Above every mode: setup and its progress shouldn't depend on which panel is showing
    h("div", { class: "banner" }, say, setupBox),
    h(
      "div",
      { class: "grid" },
      h("div", { class: "area-bin" }, binPanel, h("section", { class: "panel refs", "aria-label": "Style references" }, h("h2", {}, "References"), referencesEl, addAspectBin, h("button", { type: "button", class: "btn wide", onclick: () => refPicker.click() }, "Add a reference…"))),
      h(
        "section",
        { class: "area-monitor panel", "aria-label": "Monitor" },
        monitorFrame,
        ...(replay ? [replay.el] : []),
        // The transport in groups (redesign 2026-11-12): playing, marking, how the picture is shown, drawing on it
        h(
          "div",
          { class: "transport" },
          h("div", { class: "tgroup tplay" }, play, time, ...(level ? [level] : []), which, ...(shortcuts ? [h("button", { type: "button", class: "btn keys-open", "aria-label": "Keyboard shortcuts", "aria-keyshortcuts": "?", title: "Keyboard shortcuts (?)", onclick: () => shortcuts.open() }, "?")] : [])),
          h("div", { class: "tgroup" }, markButtons),
          h("div", { class: "tgroup tview" }, shape, ...(compareButton ? [compareButton] : []), h("label", { class: "inline" }, guides, " Safe zones"), h("label", { class: "inline" }, "Zoom ", zoom)),
        ),
        ...(drawing ? [drawing.tools] : []),
      ),
      h("aside", { class: "area-kriya panel inspector", "aria-label": "Kriya" }, sideHandle, inspector.strip, briefPanel, chatPanel, activityPanel),
      h("section", { class: "area-transcript panel", "aria-label": "Transcript" }, h("h2", {}, "Transcript"), h("p", { class: "note small hint" }, "Click a word to jump there. Double-click (or F2) to fix a misheard word."), transcriptEl),
      storyEl,
      h("div", { class: "area-strip" }, stripEl),
      h("section", { class: "area-timeline panel", "aria-label": "Timeline" }, timelineEl),
      h("div", { class: "area-finish" }, finishEl),
      finalEl,
    ),
  )
  if (assemblyOn) root.classList.add("has-story")
  clear(app).append(root)
  const savedSide = Number(remember("kriya-side-width"))
  if (savedSide >= SIDE.min) root.style.setProperty("--side", `${Math.min(sideMax(), savedSide)}px`)
  setMode(mode)
  sideHandle.setAttribute("aria-valuemax", String(sideMax()))
  sideHandle.setAttribute("aria-valuenow", String(Math.round(sideNow())))

  window.onkeydown = (event) => {
    const typing = event.target.closest?.("input, select, textarea")
    if (typing && event.key !== "Escape") return
    if (event.key === "Escape") {
      // Escape lets go: of the field, then of the selection that "this" would mean
      if (typing) return document.activeElement?.blur()
      transcript.clear()
      timeline.select(null)
      markIn = markOut = null
      return showChip()
    }
    if (shortcuts && event.key === "?" && !event.metaKey && !event.ctrlKey) return (event.preventDefault(), shortcuts.open())
    const action = keyAction(event.key, { shift: event.shiftKey, mod: event.metaKey || event.ctrlKey })
    if (!action) return
    // A focused button keeps Space and Enter for itself, except the transport's own
    if (action.type === "toggle" && event.target.closest?.("button") && event.target !== play) return
    event.preventDefault()
    act(action)
  }
  setInterval(() => mode === "finish" && finish.scopes(), 250)
  const events = new EventSource("/events")
  events.addEventListener("job", (event) => {
    let job = null
    try {
      job = JSON.parse(event.data)
    } catch {}
    if (job?.id) jobsNow.set(job.id, job)
    if (liveOn && job?.id && job.id === makeJob && !["pending", "running"].includes(job.status)) endDirector()
    styleJob(job)
    if (mode === "finish") finish.refresh().catch(() => {})
    makeProgress().catch(() => {})
    openingsProgress().catch(() => {})
    // Progress alone redraws the bin; a job that ended reloads what it changed
    if (job && ["pending", "running"].includes(job.status)) renderBin()
    else reload().catch(() => {})
  })
  if (liveOn) events.addEventListener("live", onLiveEvent)
  events.addEventListener("setup", (event) => {
    try {
      showRuntime({ ...(runtime ?? {}), setup: JSON.parse(event.data) })
    } catch {}
    if (runtime?.setup?.finished) api("GET", "/runtime").then(showRuntime).catch(() => {})
  })

  api("GET", "/runtime").then(showRuntime).catch(() => {})
  await reload()
  window.__studio = { monitor, act, reload, setMode, get pieces() { return pieces }, ...(liveOn ? { director: { get states() { return buildStrip.states }, get showing() { return directorShowing }, get replay() { return { open: replay.open, at: replay.at } } } } : {}) } // for the Studio's own browser tests
}

/* ───────────────────────────── route ──────────────────────────── */

function route() {
  const match = /^#\/p\/([0-9a-f]{16})$/.exec(location.hash)
  if (match) workspace(match[1])
  else home()
}
window.addEventListener("hashchange", route)
route()
