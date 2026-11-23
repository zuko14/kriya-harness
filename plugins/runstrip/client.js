// Harness 2.0 W18 (WD-23), browser half: the Run strip in shell.bottom, the
// gate chip, Mission Control (a "Missions" row in the sidebar's panel list and
// its page in the main slot) and the four tracks' extra sections. Only
// mounted with --runstrip; it then tells the Overview, Progress, Preview and
// Changes tabs to read as Project, Proof, Live and Changes (same tab kinds, so
// the old ids keep working). Everything shown comes from index.js, which reads
// the loop's ledger only. Brand tokens only; no DSH file is edited (HD-02).
window.__ModuleLoader__.load({
  id: "@kriya-ai/harness-runstrip",
  factory: (require) => {
    const React = require("react")
    const { useCallback, useEffect, useRef, useState } = React
    const h = React.createElement

    const PLUGIN = "@kriya-ai/harness-runstrip"
    const PANEL_ID = "kriya-missions"
    const API = { strip: "api/kriya.runstrip", stop: "api/kriya.runstrip.stop", missions: "api/kriya.missions", track: "api/kriya.tracks", restore: "api/kriya.tracks.restore", verify: "api/kriya.tracks.receipt-verify" }
    const STRIP_MS = 2000
    const TRACK_MS = 4000
    // The four tracks, in their fixed order, and the tab kinds they are (src/runstrip.js TRACKS)
    const TRACKS = [
      ["live", "kriya-preview", "Live"],
      ["proof", "kriya-progress", "Proof"],
      ["changes", "kriya-changes", "Changes"],
      ["project", "kriya-overview", "Project"],
    ]

    const CSS = `
.kh-chip { box-sizing: border-box; flex: none; display: inline-flex; align-items: center; gap: 5px; width: 14.5em; height: 28px; padding: 0 9px; border-radius: 999px; border: 1.5px solid var(--dsw-alias-label-tertiary); color: var(--dsw-alias-label-secondary); font-size: 11.5px; line-height: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: background-color .16s ease-out, border-color .16s ease-out, color .16s ease-out; }
.kh-chip-g { flex: none; width: 1em; text-align: center; font-weight: 700; }
.kh-chip-t { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.kh-chip[data-state="passed"] { background: var(--dsw-alias-link); border-color: var(--dsw-alias-link); color: var(--dsw-alias-label-primary-foreground, #fff); }
.kh-chip[data-state="failed"] { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.kh-chip[data-state="not-checked"] { border-style: dashed; }
.kh-chip[data-state="running"] { border-color: transparent; color: var(--dsw-alias-state-warn-label);
  background: linear-gradient(90deg, var(--dsw-alias-state-warn-primary) 50%, transparent 0) repeat-x top / 8px 1.5px, linear-gradient(90deg, var(--dsw-alias-state-warn-primary) 50%, transparent 0) repeat-x bottom / 8px 1.5px, linear-gradient(0deg, var(--dsw-alias-state-warn-primary) 50%, transparent 0) repeat-y left / 1.5px 8px, linear-gradient(0deg, var(--dsw-alias-state-warn-primary) 50%, transparent 0) repeat-y right / 1.5px 8px;
  animation: kh-stitch 1.2s linear infinite; }
@keyframes kh-stitch { to { background-position: 8px 0, -8px 100%, 0 -8px, 100% 8px; } }
.kh-chips { display: flex; gap: 6px; flex-wrap: wrap; min-width: 0; }
.kh-rs { box-sizing: border-box; height: 44px; overflow: hidden; border-top: .5px solid var(--kh-edge, var(--dsw-alias-border-l2)); background: var(--kh-glass-thick, var(--dsw-alias-bg-layer-1)); backdrop-filter: var(--kh-blur, none); color: var(--dsw-alias-label-primary); font-size: 12.5px; transition: height .2s ease-out; }
.kh-rs[data-open="true"] { height: 240px; }
.kh-rs-row { display: flex; align-items: center; gap: 10px; height: 44px; padding: 0 6px 0 14px; min-width: 0; }
.kh-rs-sum { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; min-height: 44px; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; padding: 0; }
.kh-rs-sum:focus-visible, .kh-rs-stop:focus-visible, .kh-mc-btn:focus-visible, .kh-tx-btn:focus-visible, .kh-tx-range:focus-visible { outline: 2px solid var(--dsw-alias-link); outline-offset: 2px; }
.kh-rs-step { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.kh-rs-dim { color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
.kh-rs-mono { font-family: var(--dsw-font-code, ui-monospace, monospace); font-variant-numeric: tabular-nums; }
.kh-rs-tier { flex: none; padding: 2px 8px; border-radius: 6px; background: var(--kh-chip, var(--dsw-alias-bg-layer-1)); box-shadow: var(--kh-rim, none); font-size: 11.5px; font-weight: 600; }
.kh-rs-count { display: none; }
.kh-rs-stop { flex: none; min-width: 44px; min-height: 44px; padding: 0 14px; border: 0; border-radius: 12px; background: transparent; color: var(--dsw-alias-state-error-primary); font: inherit; font-weight: 600; cursor: pointer; }
.kh-rs-stop:hover { background: var(--dsw-alias-interactive-bg-hover-danger, var(--dsw-alias-interactive-bg-hover)); }
.kh-rs-more { flex: none; }
.kh-rs-tl { height: 196px; overflow: auto; padding: 0 14px 10px; }
.kh-rs-at { display: grid; grid-template-columns: 6.5em 4.5em minmax(6em, 10em) 1fr 4em; gap: 10px; align-items: center; min-height: 34px; border-top: 1px dashed var(--dsw-alias-border-l2); }
.kh-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (max-width: 1023px) { .kh-rs-wide { display: none; } }
@media (max-width: 767px) { .kh-rs-mid, .kh-rs-row .kh-chips { display: none; } .kh-rs-count { display: inline; } .kh-rs-at { grid-template-columns: 5.5em 1fr 3.5em; } .kh-rs-at > :nth-child(2), .kh-rs-at > :nth-child(4) { display: none; } }
@media (prefers-reduced-motion: reduce) { .kh-chip, .kh-rs { transition: none; } .kh-chip[data-state="running"] { animation: none; } }
.kh-mc { height: 100%; overflow: auto; padding: 32px; box-sizing: border-box; color: var(--dsw-alias-label-primary); font-size: 14px; }
.kh-mc-title { margin: 0 0 6px; font-family: var(--dsw-font-family-brand); font-size: 30px; line-height: 36px; font-weight: 420; letter-spacing: -0.016em; }
.kh-mc-sub { margin: 0 0 20px; color: var(--dsw-alias-label-secondary); line-height: 1.5; max-width: 60ch; }
.kh-mc-card { padding: 14px 16px; border-radius: 16px; background: var(--kh-chip, var(--dsw-alias-bg-layer-1)); box-shadow: var(--kh-rim, inset 0 0 0 1px var(--dsw-alias-border-l3)); margin-bottom: 10px; }
.kh-mc-row { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: baseline; justify-content: space-between; }
.kh-mc-btn, .kh-tx-btn { min-height: 44px; min-width: 44px; padding: 0 14px; border-radius: 12px; border: 0; background: var(--kh-chip, var(--dsw-alias-bg-layer-1)); box-shadow: var(--kh-rim, inset 0 0 0 1px var(--dsw-alias-border-l3)); color: inherit; font: inherit; cursor: pointer; }
.kh-mc-note, .kh-tx-note { color: var(--dsw-alias-label-tertiary); line-height: 1.5; }
.kh-mc-error, .kh-tx-error { color: var(--dsw-alias-state-error-primary); }
.kh-tx { padding: 10px 14px; border-bottom: 1px solid var(--dsw-alias-border-l2); font-size: 13px; color: var(--dsw-alias-label-primary); }
.kh-tx-h { margin: 0 0 8px; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.kh-tx-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; min-height: 32px; }
.kh-tx-vp { display: flex; gap: 6px; flex-wrap: wrap; }
.kh-tx-btn[aria-pressed="true"] { box-shadow: inset 0 0 0 1.5px var(--dsw-alias-link); font-weight: 600; }
.kh-tx-range { width: 100%; min-height: 44px; accent-color: var(--dsw-alias-link); }
.kh-tx-mono { font-family: var(--dsw-font-code, ui-monospace, monospace); font-size: 12px; }
.kh-tx-banner { padding: 8px 12px; border-radius: 12px; font-weight: 600; }
.kh-tx-banner[data-ok="true"] { color: var(--dsw-alias-link); box-shadow: inset 0 0 0 1px var(--dsw-alias-link); }
.kh-tx-banner[data-ok="false"] { color: var(--dsw-alias-state-error-primary); box-shadow: inset 0 0 0 1px var(--dsw-alias-state-error-primary); }
.kh-tx-grid { display: grid; grid-template-columns: 7em 1fr; gap: 4px 10px; }
`

    function installStyles() {
      const tag = document.createElement("style")
      tag.dataset.plugin = PLUGIN
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    /* ─────────────────────────────── data ─────────────────────────────── */

    const message = (e) => (e?.message === "Failed to fetch" ? "Kriya Harness isn't answering; is it still running?" : String(e?.message ?? e))
    async function getJson(url, init) {
      const response = await fetch(url, { credentials: "same-origin", ...init })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || `Kriya answered ${response.status}.`)
      return body
    }
    const post = (url, body) => getJson(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

    /** Polls `url` every `ms` while the page is visible: { data, error, reload }. */
    function usePoll(url, ms) {
      const [state, setState] = useState({ data: null, error: null })
      const reload = useCallback(() => {
        if (!url) return Promise.resolve()
        return getJson(url).then((data) => setState({ data, error: null }), (e) => setState((s) => ({ data: s.data, error: message(e) })))
      }, [url])
      useEffect(() => {
        reload()
        if (!ms) return
        const timer = setInterval(() => (typeof document === "undefined" || !document.hidden) && reload(), ms)
        return () => clearInterval(timer)
      }, [reload, ms])
      return { ...state, reload }
    }

    /* ───────────────────────────── gate chip ──────────────────────────── */

    const GLYPH = { waiting: "○", running: "◐", passed: "✓", failed: "×", "not-checked": "–" }

    /** One gate: five states, its words always present, its width fixed (no layout shift). */
    function GateChip({ chip }) {
      return h(
        "span",
        { className: "kh-chip", "data-state": chip.state, title: chip.text, role: "img", "aria-label": chip.text },
        h("span", { className: "kh-chip-g", "aria-hidden": true }, GLYPH[chip.state] ?? "○"),
        h("span", { className: "kh-chip-t", "aria-hidden": true }, chip.text)
      )
    }
    const Chips = ({ chips }) => (chips?.length ? h("span", { className: "kh-chips" }, chips.map((c) => h(GateChip, { key: c.id, chip: c }))) : null)

    /* ───────────────────────────── run strip ──────────────────────────── */

    function elapsed(ms) {
      const s = Math.max(0, Math.floor(ms / 1000))
      if (s < 60) return `${s}s`
      const m = Math.floor(s / 60)
      return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`
    }
    const passedOf = (chips) => `${chips.filter((c) => c.state === "passed").length}/${chips.length} passed`

    /** What the live region says, once per change of the finished attempts' verdict, never per chip. */
    function announcement(prev, run) {
      if (!run) return prev?.running ? { key: "idle", text: "Nothing is running." } : null
      const done = run.attempts.filter((a) => a.outcome !== "building")
      const last = done.at(-1)
      const key = `${run.sessionId}:${run.step.n}:${done.length}:${last?.outcome ?? ""}`
      if (prev?.key === key) return null
      return { key, running: true, text: last ? `Step ${run.step.n}, attempt ${last.n}: ${last.outcome}.` : `Step ${run.step.n} started: ${run.step.title}.` }
    }

    function Strip() {
      const { data } = usePoll(API.strip, STRIP_MS)
      const [open, setOpen] = useState(false)
      const [said, setSaid] = useState(null)
      const [error, setError] = useState(null)
      const run = data?.runs?.[0]
      const stop = useCallback(() => run && post(API.stop, { session: run.sessionId }).then(() => setError(null), (e) => setError(message(e))), [run?.sessionId])
      useEffect(() => {
        const next = announcement(said, run)
        if (next) setSaid({ ...next, running: Boolean(run) })
      }, [run])
      useEffect(() => {
        const onKey = (e) => {
          if (!e.altKey || e.metaKey || e.ctrlKey) return
          if (e.code === "ArrowUp" && run) (e.preventDefault(), setOpen((o) => !o))
          else if (e.code === "Period" && run) (e.preventDefault(), stop())
        }
        window.addEventListener("keydown", onKey)
        return () => window.removeEventListener("keydown", onKey)
      }, [run, stop])
      const live = h("div", { className: "kh-sr", role: "status", "aria-live": "polite" }, said?.text ?? "")
      // Idle: nothing but the empty live region, so the slot reserves no space
      if (!run) return live
      const more = data.runs.length > 1 ? ` · +${data.runs.length - 1} more` : ""
      return h(
        "section",
        { className: "kh-rs", "data-open": String(open), "aria-label": "Run strip" },
        live,
        h(
          "div",
          { className: "kh-rs-row" },
          h(
            "button",
            { type: "button", className: "kh-rs-sum", "aria-expanded": open, "aria-keyshortcuts": "Alt+ArrowUp", title: "Attempts (⌥↑)", onClick: () => setOpen((o) => !o) },
            run.milestone && h("span", { className: "kh-rs-dim kh-rs-mid" }, `Milestone ${run.milestone.n}/${run.milestone.of} ›`),
            h("span", { className: "kh-rs-step" }, `Step ${run.step.n}`, h("span", { className: "kh-rs-mid" }, ` "${run.step.title}"`)),
            h("span", { className: "kh-rs-dim kh-rs-mono kh-rs-mid" }, `try ${run.attempt.n}/${run.attempt.of}${run.attempt.polish ? " · polish" : ""}`),
            run.tier && h("span", { className: "kh-rs-tier kh-rs-mid", title: run.tier.model, "aria-label": `${run.tier.level}: ${run.tier.model}` }, run.tier.level),
            h(Chips, { chips: run.gates }),
            run.gates.length > 0 && h("span", { className: "kh-rs-count kh-rs-dim" }, passedOf(run.gates)),
            h("span", { className: "kh-rs-dim kh-rs-mono kh-rs-wide" }, elapsed(run.elapsedMs)),
            run.spend && h("span", { className: "kh-rs-dim kh-rs-mono kh-rs-wide", title: run.spend.estimated ? "Estimated: some requests aren't priced yet" : "This task's spend" }, `${run.spend.inr}${run.spend.estimated ? " est." : ""}`),
            more && h("span", { className: "kh-rs-dim kh-rs-wide" }, more)
          ),
          error && h("span", { className: "kh-mc-error", role: "alert" }, error),
          h("button", { type: "button", className: "kh-rs-stop", onClick: stop, "aria-keyshortcuts": "Alt+Period", title: "Stop (⌥.)" }, "Stop")
        ),
        open &&
          h(
            "div",
            { className: "kh-rs-tl", role: "list", "aria-label": "Attempts" },
            run.attempts.map((a) =>
              h(
                "div",
                { key: a.n, className: "kh-rs-at", role: "listitem" },
                h("span", null, `Attempt ${a.n}`),
                h("span", { className: "kh-rs-dim" }, a.tier ?? "–"),
                h("span", { className: a.outcome === "passed" ? "" : "kh-rs-dim" }, a.outcome),
                h(Chips, { chips: a.gates }),
                h("span", { className: "kh-rs-dim kh-rs-mono" }, elapsed(a.durationMs))
              )
            )
          )
      )
    }

    /* ──────────────────────────── track extras ─────────────────────────── */

    const trackUrl = (sessionId, part) => sessionId && `${API.track}?${new URLSearchParams({ session: sessionId, part })}`
    const Section = (title, body, action) => h("section", { className: "kh-tx", "aria-label": title }, h("h3", { className: "kh-tx-h" }, title, action), body)
    /** Loading, error and empty states every extra shares; null when there is data to show. */
    function states({ data, error }, empty) {
      if (error && !data) return h("div", { className: "kh-tx-error", role: "alert" }, error)
      if (!data) return h("div", { className: "kh-tx-note" }, "Loading…")
      return empty(data) ? h("div", { className: "kh-tx-note" }, empty(data)) : null
    }

    const VIEWPORTS = [360, 390, 1440]
    /** Live: the viewport switch and the page gates drawn over the frame. */
    function LiveExtra({ sessionId, viewport, setViewport }) {
      const poll = usePoll(trackUrl(sessionId, "live"), TRACK_MS)
      return Section(
        "Live",
        h(
          React.Fragment,
          null,
          h(
            "div",
            { className: "kh-tx-vp", role: "group", "aria-label": "Viewport" },
            h("button", { type: "button", className: "kh-tx-btn", "aria-pressed": !viewport, onClick: () => setViewport(null) }, "Fit"),
            VIEWPORTS.map((w) => h("button", { key: w, type: "button", className: "kh-tx-btn", "aria-pressed": viewport === w, onClick: () => setViewport(w) }, `${w}`))
          ),
          sessionId && (states(poll, (d) => (d.gates.length ? null : "No page gate has run for this session yet.")) ?? h(Chips, { chips: poll.data.gates }))
        )
      )
    }

    /** Proof: each step's chips, release readiness and the receipt with Copy and Verify. */
    function ProofExtra({ sessionId }) {
      const poll = usePoll(trackUrl(sessionId, "proof"), TRACK_MS)
      const [check, setCheck] = useState(null)
      const early = states(poll, (d) => (!d.steps.length && !d.release && !d.receipt ? "No plan yet. Ask for something with more than one step and the plan appears here." : null))
      if (early) return Section("Proof", early)
      const d = poll.data
      const verify = () => post(API.verify, { session: sessionId }).then(setCheck, (e) => setCheck({ ok: false, problems: [message(e)] }))
      return h(
        React.Fragment,
        null,
        d.steps.some((s) => s.chips.length) &&
          Section("Gates by step", d.steps.map((s) => h("div", { key: s.n, className: "kh-tx-row" }, h("span", { className: "kh-tx-mono" }, `${s.n}.`), s.chips.length ? h(Chips, { chips: s.chips }) : h("span", { className: "kh-tx-note" }, "no gates run")))),
        Section(
          "Release readiness",
          d.release
            ? h(
                React.Fragment,
                null,
                h("div", { className: "kh-tx-banner", "data-ok": String(d.release.ready) }, d.release.ready ? `Ready at ${d.release.commit}` : `Not ready at ${d.release.commit}`),
                h("div", { className: "kh-tx-grid" }, d.release.lines.flatMap((l) => [h("span", { key: `${l.id}a`, className: "kh-tx-mono" }, l.id), h("span", { key: `${l.id}b` }, l.status)]))
              )
            : h("div", { className: "kh-tx-note" }, "Not checked: no release check has run (kriya release check).")
        ),
        Section(
          "Receipt",
          d.receipt
            ? h(
                React.Fragment,
                null,
                h("div", { className: "kh-tx-row" }, `Verdict ${d.receipt.verdict} · ${d.receipt.runs} run${d.receipt.runs === 1 ? "" : "s"}${d.receipt.commit ? ` · ${d.receipt.commit}` : ""}`),
                h("div", { className: "kh-tx-row kh-tx-mono", title: d.receipt.chain }, d.receipt.chain.slice(0, 26), "…"),
                h(
                  "div",
                  { className: "kh-tx-row" },
                  h("button", { type: "button", className: "kh-tx-btn", onClick: () => navigator.clipboard?.writeText(d.receipt.markdown) }, "Copy"),
                  h("button", { type: "button", className: "kh-tx-btn", onClick: verify }, "Verify")
                ),
                check && h("div", { className: "kh-tx-banner", role: "status", "data-ok": String(check.ok) }, check.ok ? "The receipt matches this computer's records." : check.problems.join(" "))
              )
            : h("div", { className: "kh-tx-note" }, "No receipt yet: one is made on request (kriya receipt make) or with a draft pull request.")
        )
      )
    }

    /** Changes: a time scrubber over this session's checkpoints, and "Restore this point". */
    function ChangesExtra({ sessionId }) {
      const poll = usePoll(trackUrl(sessionId, "changes"), TRACK_MS)
      const [at, setAt] = useState(null)
      const [note, setNote] = useState(null)
      const early = states(poll, (d) => (d.points.length ? null : "No checkpoints yet: one is saved before each step changes files."))
      if (early) return Section("Time", early)
      const points = poll.data.points
      const i = at === null || at >= points.length ? points.length - 1 : at
      const p = points[i]
      const restore = () => {
        if (!window.confirm(`Put the files back as they were at "${p.label}"? The files as they are now are saved first, so this can be undone with kriya undo.`)) return
        post(API.restore, { session: sessionId, commit: p.commit }).then((r) => (setNote(`Restored: ${r.changed} file${r.changed === 1 ? "" : "s"} changed.`), poll.reload()), (e) => setNote(message(e)))
      }
      return Section(
        `Time · ${points.length} point${points.length === 1 ? "" : "s"}`,
        h(
          React.Fragment,
          null,
          h("input", { type: "range", className: "kh-tx-range", min: 0, max: points.length - 1, step: 1, value: i, onChange: (e) => setAt(Number(e.target.value)), "aria-label": "Checkpoint", "aria-valuetext": `${p.label}, ${p.verdict ?? "not checked"}` }),
          h("div", { className: "kh-tx-row" }, h("span", { className: "kh-tx-mono" }, new Date(p.at).toLocaleTimeString()), h("span", null, p.label), h("span", { className: "kh-tx-note" }, p.verdict ? `then: ${p.verdict}` : "not checked")),
          h("div", { className: "kh-tx-row" }, h("button", { type: "button", className: "kh-tx-btn", onClick: restore }, "Restore this point")),
          note && h("div", { className: "kh-tx-note", role: "status" }, note)
        )
      )
    }

    /** Project: the repository's connection state and next action, MCP servers, and the capability matrix. */
    function ProjectExtra({ sessionId }) {
      const poll = usePoll(trackUrl(sessionId, "project"), 0)
      const refresh = h("button", { type: "button", className: "kh-tx-btn", onClick: poll.reload, "aria-label": "Check the project again" }, "Check again")
      const early = states(poll, () => null)
      if (early) return Section("Project", early, refresh)
      const d = poll.data
      return h(
        React.Fragment,
        null,
        Section("Repository", h(React.Fragment, null, h("div", { className: "kh-tx-row" }, h("b", null, d.repo.state)), h("div", { className: "kh-tx-note", style: { whiteSpace: "pre-line" } }, d.repo.text)), refresh),
        d.workforce &&
          Section(
            "Harness 2.0",
            h(
              React.Fragment,
              null,
              h("div", { className: "kh-tx-row" }, d.workforce.orchestra ? `Orchestra: head ${d.workforce.orchestra.headName ?? d.workforce.orchestra.head}, worker ${d.workforce.orchestra.workerName ?? d.workforce.orchestra.worker}` : "Orchestra: off (one level for everything)"),
              h("div", { className: "kh-tx-grid" }, d.workforce.switches.flatMap((x) => [h("span", { key: `${x.flag}a`, className: "kh-tx-mono" }, x.flag), h("span", { key: `${x.flag}b`, className: x.on ? "" : "kh-tx-note" }, x.on ? "on" : "off")]))
            )
          ),
        Section("MCP servers", d.mcp.length ? d.mcp.map((m) => h("div", { key: m.id, className: "kh-tx-row" }, m.name)) : h("div", { className: "kh-tx-note" }, "None offered (kriya --mcp, and the owner's registry).")),
        Section(
          "What can be checked here",
          h("div", { className: "kh-tx-grid" }, d.matrix.flatMap((r) => [h("span", { key: `${r.gate}a`, className: "kh-tx-mono" }, r.gate), h("span", { key: `${r.gate}b`, className: r.works ? "" : "kh-tx-note" }, r.works ? "works" : `needs ${r.needs}`)]))
        )
      )
    }

    /* ─────────────────────────── mission control ───────────────────────── */

    function MissionsPage() {
      const poll = usePoll(API.missions, TRACK_MS)
      const head = [h("h1", { key: "t", className: "kh-mc-title" }, "Missions"), h("p", { key: "s", className: "kh-mc-sub" }, "Everything running on this computer: each project's milestones, what it waits for, and this month's spend.")]
      if (poll.error && !poll.data) return h("div", { className: "kh-mc" }, head, h("p", { className: "kh-mc-error", role: "alert" }, poll.error))
      if (!poll.data) return h("div", { className: "kh-mc" }, head, h("p", { className: "kh-mc-note" }, "Loading…"))
      const d = poll.data
      return h(
        "div",
        { className: "kh-mc" },
        head,
        h(
          "div",
          { className: "kh-mc-card" },
          h(
            "div",
            { className: "kh-mc-row" },
            h("span", null, d.signedIn ? "Signed in to Kriya" : "Not signed in: run kriya login"),
            d.account ? h("span", { className: "kh-rs-mono" }, `${d.account.used} of ${d.account.cap} this month${d.account.estimated ? " (estimated)" : ""}`) : d.signedIn && h("span", { className: "kh-mc-note" }, "Spend unavailable right now")
          )
        ),
        d.missions.length
          ? d.missions.map((m) =>
              h(
                "div",
                { key: m.root, className: "kh-mc-card" },
                h("div", { className: "kh-mc-row" }, h("b", { title: m.root }, m.project), h("span", { className: "kh-rs-mono" }, `${m.done}/${m.of} milestones · ${m.status}`)),
                m.current && h("div", null, `Milestone ${m.current.n}: ${m.current.title}`),
                h("div", { className: "kh-mc-note" }, `Waiting for: ${m.waiting}`)
              )
            )
          : h("p", { className: "kh-mc-note" }, "No missions yet. Long work gets milestones (kriya --milestones), and each project's appear here.")
      )
    }

    const MissionsIcon = ({ size = 20 }) =>
      h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, h("path", { d: "M4 5h16M4 12h10M4 19h6" }), h("circle", { cx: 18, cy: 16, r: 3 }))

    /* ─────────────────────────────── apply ──────────────────────────────── */

    // The seam the four tab plugins read (they render these only when present): titles, order, extras
    const extras = {
      title: Object.fromEntries(TRACKS.map(([, kind, title]) => [kind, title])),
      order: Object.fromEntries(TRACKS.map(([, kind], i) => [kind, i + 1])),
      Live: LiveExtra,
      Proof: ProofExtra,
      Changes: ChangesExtra,
      Project: ProjectExtra,
      GateChip,
    }

    function openTrack(ctx, n) {
      try {
        ctx.get?.("sidebarRight")?.openTab(TRACKS[n][1])
      } catch {
        // No session open: nothing to show a track for
      }
    }

    const inject = ["slots"]

    function apply(ctx) {
      if (typeof document !== "undefined") ctx.effect(installStyles, "kriya-runstrip: styles")
      ctx.effect(() => {
        globalThis.__kriyaTracks = extras
        return () => {
          if (globalThis.__kriyaTracks === extras) delete globalThis.__kriyaTracks
        }
      }, "kriya-runstrip: tracks")
      if (typeof window !== "undefined" && window.addEventListener)
        ctx.effect(() => {
          const onKey = (e) => {
            const n = /^Digit([1-4])$/.exec(e.code ?? "")
            if (!n || !e.altKey || e.metaKey || e.ctrlKey) return
            e.preventDefault()
            openTrack(ctx, Number(n[1]) - 1)
          }
          window.addEventListener("keydown", onKey)
          return () => window.removeEventListener("keydown", onKey)
        }, "kriya-runstrip: track keys")
      ctx.slots.inject("shell.bottom", () => ctx.slots.register({ name: "shell.bottom", key: PLUGIN }, Strip))
      ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: PANEL_ID }, MissionsPage))
      ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: 6, label: "Missions" }, MissionsIcon))
    }

    return { apply, inject, Strip, GateChip, MissionsPage, LiveExtra, ProofExtra, ChangesExtra, ProjectExtra, announcement, extras, TRACKS, API, CSS }
  },
})
