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
          if (reference) referenceChoice = asset.id
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
  let referenceChoice = ""
  const referencesEl = h("ul", { class: "bin", "aria-label": "Style references" })
  const refPicker = h("input", {
    type: "file",
    accept: "video/*,.mov,.mp4,.m4v,.mkv,.webm",
    hidden: true,
    id: "pick-reference",
    onchange: () => {
      const files = [...refPicker.files]
      refPicker.value = ""
      const ok = files.length && confirm("Use this video only as a style reference?\n\nKriya measures its pace and whether it has captions, as numbers. No picture, sound or words from it go into your video. Add only a video you're allowed to use this way.")
      if (ok) upload(files, { reference: true })
    },
  })
  function renderReferences() {
    clear(referencesEl)
    const refs = assets.filter((a) => a.kind === "reference")
    if (!refs.length) referencesEl.append(h("li", { class: "note" }, "None yet. Add a video whose pace and captions you like."))
    for (const ref of refs) referencesEl.append(h("li", { class: "asset" }, h("button", { type: "button", class: "btn", onclick: () => showSource(ref.id, 0) }, `${ref.path.split(/[\\/]/).at(-1)} · reference`)))
    // The make panel's choices follow what's in the project
    const keep = (select, list, none) => {
      const was = select.value
      clear(select).append(h("option", { value: "" }, none), ...list.map((a) => h("option", { value: a.id }, a.path.split(/[\\/]/).at(-1))))
      select.value = list.some((a) => a.id === was) ? was : ""
    }
    keep(makeReference, refs, "No reference")
    if (referenceChoice && refs.some((a) => a.id === referenceChoice)) ((makeReference.value = referenceChoice), (referenceChoice = ""))
    keep(makeMusic, assets.filter((a) => a.kind === "audio"), "No music")
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
  /** A request about the whole video: the Director's make job does it, with the panel's choices. */
  function showDirect(direct) {
    const brief = direct.brief ?? {}
    const box = h(
      "div",
      { class: "proposal direct" },
      h("p", { class: "lead" }, "That's about the whole video"),
      h("p", { class: "note" }, `The Director can make it: the best takes, the story, ${brief.captions || makeCaptions.value ? "captions, " : ""}punch-ins and a checked master${brief.seconds ? `, about ${brief.seconds} s` : ""}.`),
      h("div", { class: "row" }, h("button", { type: "button", class: "btn primary", onclick: () => (box.remove(), make(brief)) }, "Direct it"), h("button", { type: "button", class: "btn", onclick: () => box.remove() }, "Not now")),
    )
    proposalEl.append(box)
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
          const { proposal, direct, reason } = await api("POST", `/projects/${id}/ask`, { text, selection: selectionNow().selection })
          say.textContent = proposal || direct ? "" : (reason ?? "Kriya couldn't turn that into an edit.")
          if (proposal || direct) prompt.value = ""
          showProposal(proposal)
          if (direct) showDirect(direct)
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
  // What the Director makes: the length, captions, music and a style reference, all optional
  const makeLength = h("select", { id: "make-length", class: "field select" }, [["", "Length: auto (30–60 s)"], ["30", "30 seconds"], ["45", "45 seconds"], ["60", "60 seconds"], ["90", "90 seconds"]].map(([value, label]) => h("option", { value }, label)))
  const makeCaptions = h("select", { id: "make-captions", class: "field select" }, [["", "No captions"], ["clean", "Captions: clean"], ["karaoke", "Captions: karaoke"], ["boxed", "Captions: boxed"]].map(([value, label]) => h("option", { value }, label)))
  const makeMusic = h("select", { id: "make-music", class: "field select" })
  const makeReference = h("select", { id: "make-reference", class: "field select" })
  const briefNow = (extra = {}) => ({
    ...(makeLength.value ? { seconds: Number(makeLength.value) } : {}),
    ...(makeCaptions.value ? { captions: makeCaptions.value } : {}),
    ...(makeMusic.value ? { music: makeMusic.value } : {}),
    ...(makeReference.value ? { reference: makeReference.value } : {}),
    ...extra,
  })
  async function make(extra) {
    try {
      const job = await api("POST", `/projects/${id}/make`, { brief: briefNow(extra) })
      makeJob = job.id
      jobsNow.set(job.id, job)
      say.textContent = "Directing your reel: reading the footage, choosing the story, cutting and checking it. You can keep working."
      showMake()
    } catch (error) {
      say.textContent = error.message
    }
  }
  const makeButton = h("button", { type: "button", class: "btn primary wide", onclick: () => make() }, "Make a reel")
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
    h("label", { for: "make-length", class: "sr-only" }, "Length"),
    makeLength,
    h("label", { for: "make-captions", class: "sr-only" }, "Captions"),
    makeCaptions,
    h("label", { for: "make-music", class: "sr-only" }, "Music"),
    makeMusic,
    h("label", { for: "make-reference", class: "sr-only" }, "Style reference"),
    h("div", { class: "row tight" }, makeReference, refPicker, h("button", { type: "button", class: "btn", "aria-label": "Add a style reference", title: "Add a style reference", onclick: () => refPicker.click() }, "+ Reference")),
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
        h("div", { class: "transport" }, play, time, which, shape, h("label", { class: "inline" }, guides, " Safe zones"), h("label", { class: "inline" }, "Zoom ", zoom)),
      ),
      h("aside", { class: "area-kriya panel", "aria-label": "Kriya" }, h("h2", {}, "Direct"), makePanel, h("h2", {}, "Ask for a change"), chip, promptForm, proposalEl, h("h2", {}, "What I did"), did),
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
