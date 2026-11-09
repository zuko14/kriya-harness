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
  const timeline = createTimeline({ root: timelineEl, onSeek: (t) => (showProgram(), monitor.seek(t)) })
  const strip = createTimeline({ root: stripEl, compact: true, onSeek: (t) => (showProgram(), monitor.seek(t)) })
  const finish = createFinish({ root: finishEl, pixels: () => monitor.pixels(), project: () => project })

  function showProgram() {
    if (!source) return
    source = null
    which.textContent = "Preview"
    monitor.load(pieces, { fps: fps(), duration: durationOf(pieces), shape: shapeNow() })
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
    showChip()
    renderBin()
    // The preview shape the person chose holds through every reload (a finished Index used to reset it)
    if (!source) await monitor.load(pieces, { fps: fps(), duration: total, shape: shapeNow() })
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
  function renderBin() {
    clear(bin)
    for (const asset of assets.filter((a) => a.kind !== "reference")) {
      const status = index.assets.find((a) => a.asset === asset.id)
      const words = status?.layers.find((l) => l.layer === "L2")
      const job = indexing(asset.id)
      const noWords = runtime?.speech ? "Indexed, no words yet: set up speech-to-text above" : (words?.notice ?? "Indexed, no words")
      const note = job ? `Reading this file… ${job.progress ?? 0}%` : !status ? "Not indexed" : words?.status === "ok" ? "Indexed" : noWords
      const media = ["video", "audio"].includes(asset.kind)
      bin.append(
        h(
          "li",
          { class: "asset" },
          h("button", { type: "button", class: "btn", onclick: () => showSource(asset.id, 0) }, `${asset.path.split(/[\\/]/).at(-1)} · ${asset.kind}`),
          h("span", { class: "note" }, asset.offline ? "Offline: the file has moved" : note),
          job ? progressBar(job.progress ?? 0, `Indexing ${asset.path.split(/[\\/]/).at(-1)}`) : null,
          media ? h("button", { type: "button", class: "btn", disabled: !!job, onclick: () => indexAsset(asset) }, status ? "Index again" : "Index") : null,
          media ? h("button", { type: "button", class: "btn", onclick: () => change([{ op: "keep_range", asset: asset.id, from: 0, to: asset.facts.duration }]) }, "Add to cut") : null,
        ),
      )
    }
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
  function upload(files, { reference = false } = {}) {
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
          say.textContent = reference ? `Added ${file.name} as a style reference.` : `Added ${file.name}. Index it to read its words.`
          if (reference) using.add(asset.id)
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
  const analyses = new Map() // asset id → its classified analysis, from the Host
  const referencesEl = h("ul", { class: "bin", "aria-label": "References" })
  const refSummary = h("p", { class: "note small" })
  const refPicker = h("input", {
    type: "file",
    accept: "video/*,image/*,audio/*,.mov,.mp4,.m4v,.mkv,.webm,.jpg,.jpeg,.png,.webp,.wav,.mp3,.m4a,.aac,.flac",
    hidden: true,
    id: "pick-reference",
    onchange: () => {
      const files = [...refPicker.files]
      refPicker.value = ""
      const ok = files.length && confirm("Use this only as a reference?\n\nKriya measures it as numbers: a video's pace, captions and colour; an image's colour grade; music's tempo and energy. No picture, sound or words from it go into your video. Add only what you're allowed to use this way.")
      if (ok) upload(files, { reference: true })
    },
  })
  function renderReferences() {
    clear(referencesEl)
    const refs = assets.filter((a) => a.kind === "reference")
    if (!refs.length) referencesEl.append(h("li", { class: "note" }, "None yet. Add a video whose editing you like, an image whose colour you like, or music whose feel you like."))
    for (const ref of refs) {
      if (!seenRefs.has(ref.id)) (seenRefs.add(ref.id), using.add(ref.id))
      const name = ref.path.split(/[\\/]/).at(-1)
      const kind = ref.facts.width ? (ref.facts.duration ? "video" : "image") : "music"
      const on = h("input", { type: "checkbox", id: `use-${ref.id}`, checked: using.has(ref.id), onchange: () => (on.checked ? using.add(ref.id) : using.delete(ref.id), showRefSummary()) })
      const found = analyses.get(ref.id)
      const lines = h("ul", { class: "ref-lines" }, ...(found ? found.lines.map((line) => h("li", {}, line)) : [h("li", { class: "note" }, "Measuring…")]))
      referencesEl.append(h("li", { class: "asset ref" }, h("button", { type: "button", class: "btn", onclick: () => ref.facts.duration && showSource(ref.id, 0) }, `${name} · ${kind}`), lines, h("label", { class: "inline", for: `use-${ref.id}` }, on, " Use in the cut")))
      if (!found) api("GET", `/projects/${id}/references/${encodeURIComponent(ref.id)}`).then((result) => (analyses.set(ref.id, result), renderReferences())).catch((error) => (analyses.set(ref.id, { lines: [`Couldn't measure it: ${error.message}`] }), renderReferences()))
    }
    showRefSummary()
    // The make panel's choices follow what's in the project
    const keep = (select, list, none) => {
      const was = select.value
      clear(select).append(h("option", { value: "" }, none), ...list.map((a) => h("option", { value: a.id }, a.path.split(/[\\/]/).at(-1))))
      select.value = list.some((a) => a.id === was) ? was : ""
    }
    keep(makeMusic, assets.filter((a) => a.kind === "audio" && !/kriya-music-/.test(a.path)), "No music")
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
    const li = h("li", { class: `msg ${who}` }, h("span", { class: "who" }, who === "you" ? "You" : "Kriya"), h("p", {}, ...withTimes(text)), ...more)
    chatEl.append(li)
    li.scrollIntoView({ block: "nearest" })
    return li
  }
  function proposalBlock(proposal) {
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
      timeline.setGhost(null)
      strip.setGhost(null)
      await reload()
    }
    box.append(
      h("p", { class: "lead" }, "Proposed, not applied yet"),
      h("ul", {}, proposal.changes.map((change, i) => h("li", {}, h("span", {}, ...withTimes(change)), proposal.changes.length > 1 ? h("button", { type: "button", class: "btn", onclick: () => decide(true, [i]) }, "Only this") : null))),
      h("div", { class: "row" }, h("button", { type: "button", class: "btn primary", onclick: () => decide(true) }, proposal.changes.length > 1 ? "Accept all" : "Accept"), h("button", { type: "button", class: "btn", onclick: () => decide(false) }, "Reject")),
    )
    return box
  }
  /* The Director's plan: pitched in words with its settings; approve it, or say what to
     change and it's revised. Nothing is made until it's approved */
  let pendingPlan = null
  const choicesNow = () => ({ ...briefNow(), ...(makeVoice.value === "clean" ? { cleanVoice: true } : {}) })
  const wordText = (wid) => index.words.find((w) => w.id === wid)?.text ?? wid
  function settingsLine(settings = {}) {
    const parts = [
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
      settings.broll === "own" ? "B-roll from your clips" : null,
      settings.titles ? "title cards" : null,
      settings.ramps ? "a speed ramp into the story" : null,
    ]
    return parts.filter(Boolean).join(" · ")
  }
  function planBlock(plan) {
    const box = h(
      "div",
      { class: "proposal plan" },
      h("p", { class: "lead" }, "The Director's plan, not made yet"),
      plan.steps.length ? h("ol", { class: "steps" }, plan.steps.map((step) => h("li", {}, ...withTimes(step)))) : null,
      h("p", { class: "note small" }, settingsLine(plan.settings)),
      h(
        "div",
        { class: "row" },
        h("button", { type: "button", class: "btn primary", onclick: () => ((pendingPlan = null), clear(box).append(h("p", { class: "note" }, "Approved. Making it now; the progress is in Direct.")), make(plan.brief, { exact: true })) }, "Approve and make it"),
        h("button", { type: "button", class: "btn", onclick: () => ((pendingPlan = plan), prompt.focus(), (prompt.placeholder = "Say what to change in the plan…")) }, "Change…"),
      ),
    )
    return box
  }
  async function askPlan(text, previous = null) {
    const thinking = message("kriya", previous ? "Revising the plan…" : "Planning the cut…")
    try {
      const plan = await api("POST", `/projects/${id}/plan`, { text, history: history.slice(-6), previous, choices: choicesNow() })
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
    const text = prompt.value.trim()
    if (!text) return
    prompt.placeholder = "Tell Kriya: \"remove 0:05 to 0:09\", \"change the caption at 0:12 to …\", \"make the start punchier\""
    // Talking about the plan: revise it; asking for a plan: plan
    if (pendingPlan || planning) {
      message("you", text)
      history.push({ who: "you", text: text.slice(0, 400) })
      prompt.value = ""
      return askPlan(text, pendingPlan)
    }
    const { selection, label } = selectionNow()
    message("you", label ? `${text}  (${label.replace(/^Selected: /, "on ")})` : text)
    prompt.value = ""
    const thinking = message("kriya", "Thinking about that…")
    try {
      const reply = await api("POST", `/projects/${id}/ask`, { text, selection, history: history.slice(-6) })
      thinking.remove()
      const words = reply.say || (reply.proposal ? "Here's what I'd change." : reply.direct ? "That's about the whole video." : (reply.reason ?? "I couldn't turn that into an edit. Try saying it another way."))
      history.push({ who: "you", text: text.slice(0, 400) })
      // A request about the whole video: the Director pitches a plan for approval
      if (reply.direct && !reply.proposal) return askPlan(text)
      message("kriya", words, reply.proposal ? proposalBlock(reply.proposal) : null)
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
    h("div", { class: "send" }, h("button", { class: "btn primary", type: "submit" }, "Send"), h("button", { type: "button", class: "btn", title: "Ask the Director for a plan of the whole cut", onclick: () => send({ planning: true }) }, "Plan")),
  )
  const markButtons = h(
    "div",
    { class: "marks", role: "group", "aria-label": "Mark a range of the cut" },
    h("button", { type: "button", class: "btn", "aria-keyshortcuts": "I", title: "Mark in (I)", onclick: () => act({ type: "mark", edge: "in" }) }, "Mark in"),
    h("button", { type: "button", class: "btn", "aria-keyshortcuts": "O", title: "Mark out (O)", onclick: () => act({ type: "mark", edge: "out" }) }, "Mark out"),
  )
  const verdictWords = { delivered: "Checked", delivered_with_notes: "Checked, with notes", blocked: "Needs you", not_checked: "Not checked" }
  // What the Director makes: the length, captions, music and a style reference, all optional
  const makeLength = h("select", { id: "make-length", class: "field select" }, [["", "Length: auto (30–60 s)"], ["30", "30 seconds"], ["45", "45 seconds"], ["60", "60 seconds"], ["90", "90 seconds"]].map(([value, label]) => h("option", { value }, label)))
  const makeCaptions = h("select", { id: "make-captions", class: "field select" }, [["", "No captions"], ["clean", "Captions: clean"], ["karaoke", "Captions: karaoke"], ["boxed", "Captions: boxed"]].map(([value, label]) => h("option", { value }, label)))
  const makeMusic = h("select", { id: "make-music", class: "field select" })
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
    const n = assets.filter((a) => a.kind === "reference" && using.has(a.id)).length
    refSummary.textContent = n ? `${n} reference${n === 1 ? "" : "s"} in use: their pace, colour and music guide the cut.` : "No references in use."
  }
  const briefNow = (extra = {}) => ({
    ...(makeLength.value ? { seconds: Number(makeLength.value) } : {}),
    ...(makeCaptions.value ? { captions: makeCaptions.value } : {}),
    ...(makeMusic.value ? { music: makeMusic.value } : {}),
    ...(using.size ? { references: [...using].filter((rid) => assets.some((a) => a.id === rid && a.kind === "reference")) } : {}),
    format: makeFormat.value,
    ...(makeGrade.value ? { grade: makeGrade.value } : {}),
    ...(makeVoice.value === "clean" ? { cleanVoice: true } : {}),
    ...(makeAngles.box.checked ? { angles: true } : {}),
    ...(makeBroll.box.checked ? { broll: "own" } : {}),
    ...(makeTitles.box.checked ? { titles: true } : {}),
    ...extra,
  })
  /** exact: the brief as given (an approved plan) plus the references in use; else the panel's choices under it */
  async function make(extra, { exact = false } = {}) {
    try {
      const refs = briefNow().references
      const job = await api("POST", `/projects/${id}/make`, { brief: exact ? { ...extra, ...(refs ? { references: refs } : {}) } : briefNow(extra) })
      makeJob = job.id
      jobsNow.set(job.id, job)
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
    if (job) makeStatus.append(h("p", { class: "note" }, `Making the reel… ${job.progress ?? 0}%`), progressBar(job.progress ?? 0, "Making the reel"))
  }
  const makePanel = h(
    "div",
    { class: "make" },
    h("label", { for: "make-template", class: "sr-only" }, "Template"),
    makeTemplate,
    h("label", { for: "make-format", class: "sr-only" }, "Format"),
    makeFormat,
    h("label", { for: "make-length", class: "sr-only" }, "Length"),
    makeLength,
    h("label", { for: "make-captions", class: "sr-only" }, "Captions"),
    makeCaptions,
    h("label", { for: "make-grade", class: "sr-only" }, "Colour look"),
    makeGrade,
    h("label", { for: "make-music", class: "sr-only" }, "Music"),
    makeMusic,
    h("label", { for: "make-voice", class: "sr-only" }, "Voice"),
    makeVoice,
    h("div", { class: "extras", role: "group", "aria-label": "Extras" }, makeAngles.el, makeBroll.el, makeTitles.el),
    h("div", { class: "row tight" }, refSummary, refPicker, h("button", { type: "button", class: "btn", "aria-label": "Add a reference", title: "Add a reference: a video, an image or music", onclick: () => refPicker.click() }, "+ Reference")),
    makeButton,
    makeStatus,
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
    for (const change of [...result.changes].reverse()) did.prepend(h("li", {}, change))
  }

  /* transport */
  const play = h("button", { type: "button", class: "btn primary", onclick: () => act({ type: "toggle" }) }, "Play")
  const shape = h("select", { class: "field small select", "aria-label": "Preview shape", onchange: () => monitor.setShape(shapeNow()) }, ["project", "16:9", "9:16"].map((value) => h("option", { value }, value === "project" ? "Project shape" : value)))
  const zoom = h("input", { type: "range", min: "1", max: "3", step: "0.05", value: "1", class: "zoom", "aria-label": "Zoom", oninput: () => monitor.setZoom(Number(zoom.value)) })
  const guides = h("input", { type: "checkbox", id: "guides", onchange: () => monitor.setGuides(guides.checked) })

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

  const root = h(
    "div",
    { class: "workspace" },
    topBar(h("span", { class: "project-name" }, project.name), modeButtons),
    // Above every mode: setup and its progress shouldn't depend on which panel is showing
    h("div", { class: "banner" }, say, setupBox),
    h(
      "div",
      { class: "grid" },
      h("div", { class: "area-bin" }, binPanel, h("section", { class: "panel refs", "aria-label": "Style references" }, h("h2", {}, "References"), referencesEl, h("button", { type: "button", class: "btn wide", onclick: () => refPicker.click() }, "Add a reference…"))),
      h(
        "section",
        { class: "area-monitor panel", "aria-label": "Monitor" },
        h("div", { class: "monitor-frame" }, canvas),
        h("div", { class: "transport" }, play, time, which, shape, markButtons, h("label", { class: "inline" }, guides, " Safe zones"), h("label", { class: "inline" }, "Zoom ", zoom)),
      ),
      h("aside", { class: "area-kriya panel", "aria-label": "Kriya" }, h("h2", {}, "Direct"), makePanel, h("h2", {}, "Chat with Kriya"), chatEl, chip, promptForm, h("p", { class: "note small" }, "Say times like 0:05 or mark a stretch with I and O. Enter sends."), h("h2", {}, "What I did"), did),
      h("section", { class: "area-transcript panel", "aria-label": "Transcript" }, h("h2", {}, "Transcript"), h("p", { class: "note small hint" }, "Click a word to jump there. Double-click (or F2) to fix a misheard word."), transcriptEl),
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
      markIn = markOut = null
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
  const events = new EventSource("/events")
  events.addEventListener("job", (event) => {
    let job = null
    try {
      job = JSON.parse(event.data)
    } catch {}
    if (job?.id) jobsNow.set(job.id, job)
    if (mode === "finish") finish.refresh().catch(() => {})
    makeProgress().catch(() => {})
    // Progress alone redraws the bin; a job that ended reloads what it changed
    if (job && ["pending", "running"].includes(job.status)) renderBin()
    else reload().catch(() => {})
  })
  events.addEventListener("setup", (event) => {
    try {
      showRuntime({ ...(runtime ?? {}), setup: JSON.parse(event.data) })
    } catch {}
    if (runtime?.setup?.finished) api("GET", "/runtime").then(showRuntime).catch(() => {})
  })

  api("GET", "/runtime").then(showRuntime).catch(() => {})
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
