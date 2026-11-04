// The Progress tab, browser half: a right-sidebar page showing what the
// Kriya loop did in this session, from its verified records (index.js):
// goal → plan → build → verify → verdict, each step with its status and
// attempts, and every check run with its exit code. Plain React and DSH's
// theme tokens; no DSH file is edited (HD-02).
window.__ModuleLoader__.load({
  id: "@kriya-ai/harness-progress",
  factory: (require) => {
    const React = require("react")
    const { useCallback, useEffect, useState } = React
    const h = React.createElement

    const PLUGIN = "@kriya-ai/harness-progress"
    const KIND = "kriya-progress"
    const API = "api/kriya.progress"
    const REFRESH_MS = 3000
    const MAX_ATTEMPTS = 4

    const CSS = `
.kh-pg { height: 100%; overflow: auto; color: var(--dsw-alias-label-primary); font-size: 13px; padding-bottom: 16px; }
.kh-pg-sec { padding: 10px 14px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.kh-pg-sec:last-child { border-bottom: 0; }
.kh-pg-h { display: flex; align-items: center; justify-content: space-between; margin: 0 0 8px; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.kh-pg-flow { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; margin: 2px 0 10px; }
.kh-pg-stage { font-size: 11.5px; padding: 3px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-tertiary); }
.kh-pg-stage.done { color: var(--dsw-alias-label-secondary); }
.kh-pg-stage.now { color: var(--dsw-alias-link); border-color: currentColor; font-weight: 600; }
.kh-pg-arrow { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.kh-pg-verdict { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; }
.kh-pg-verdict.verified { color: var(--dsw-alias-state-success-primary); }
.kh-pg-verdict.failed, .kh-pg-verdict.blocked { color: var(--dsw-alias-state-error-primary); }
.kh-pg-verdict.stale, .kh-pg-verdict.not-checked { color: var(--dsw-alias-state-warn-label); }
.kh-pg-goal { line-height: 1.45; margin: 6px 0 0; }
.kh-pg-check { margin-top: 6px; color: var(--dsw-alias-label-tertiary); }
.kh-pg-mono { font-family: var(--dsw-font-code, ui-monospace, monospace); font-size: 12px; }
.kh-pg-step { display: grid; grid-template-columns: 20px 1fr auto; gap: 8px; align-items: start; padding: 6px 0; }
.kh-pg-step + .kh-pg-step { border-top: 1px dashed var(--dsw-alias-border-l2); }
.kh-pg-ico { width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; font-weight: 700; margin-top: 1px; border: 1.5px solid var(--dsw-alias-label-tertiary); color: var(--dsw-alias-label-tertiary); }
.kh-pg-ico.pass { border-color: var(--dsw-alias-state-success-primary); background: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-bg-layer-0, #fff); }
.kh-pg-ico.fail { border-color: var(--dsw-alias-state-warn-label); color: var(--dsw-alias-state-warn-label); }
.kh-pg-ico.blocked { border-color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-bg-layer-0, #fff); }
.kh-pg-ico.skipped { border-style: dashed; }
.kh-pg-ico.next { border-color: var(--dsw-alias-link); color: var(--dsw-alias-link); }
.kh-pg-ico.building { border-color: var(--dsw-alias-link); color: var(--dsw-alias-link); border-style: dotted; }
.kh-pg-title { font-weight: 500; }
.kh-pg-sub { color: var(--dsw-alias-label-tertiary); font-size: 12px; margin-top: 2px; line-height: 1.4; }
.kh-pg-tag { font-size: 11px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.kh-pg-run { display: grid; grid-template-columns: 14px 1fr auto; gap: 8px; align-items: center; min-height: 28px; }
.kh-pg-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-state-error-primary); justify-self: center; }
.kh-pg-dot.pass { background: var(--dsw-alias-state-success-primary); }
.kh-pg-dim { color: var(--dsw-alias-label-tertiary); }
.kh-pg-val { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kh-pg-btn { min-width: 44px; min-height: 44px; margin: -12px -10px -12px 0; border: 0; border-radius: 10px; background: transparent; color: inherit; cursor: pointer; display: grid; place-items: center; }
.kh-pg-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.kh-pg-btn:focus-visible { outline: 2px solid var(--dsw-alias-link); outline-offset: -2px; }
.kh-pg-note { padding: 14px; color: var(--dsw-alias-label-tertiary); line-height: 1.5; }
.kh-pg-error { padding: 10px 14px; color: var(--dsw-alias-state-error-primary); }
`

    function installStyles() {
      const tag = document.createElement("style")
      tag.dataset.plugin = PLUGIN
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    const svg = (paths, size = 16) =>
      h(
        "svg",
        { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
        ...paths.map((d, i) => h("path", { key: i, d }))
      )
    const TabIcon = ({ size = 20 }) => svg(["M9 6h11", "M9 12h11", "M9 18h11", "M4 6l1 1 2-2", "M4 12l1 1 2-2", "M4 18h2"], size)
    const REFRESH = ["M20 11a8 8 0 1 0-2.3 5.7", "M20 4v7h-7"]

    const VERDICT = { verified: "Verified", failed: "Failing", blocked: "Blocked", "not checked": "Not checked" }
    const STEP_ICON = { pass: "✓", fail: "!", blocked: "×", skipped: "–", "not started": "", next: "›", building: "…" }
    // A builder at work: its run, steps so far, minutes and latest tool (live, from the loop)
    const buildingTag = (b) => `building · run ${b.attempt}`
    const buildingLine = (b) =>
      [`Builder at work: ${b.steps} step${b.steps === 1 ? "" : "s"}`, `${Math.max(0, Math.floor((Date.now() - b.startedAt) / 60_000))} min`, b.last && `last: ${b.last}`].filter(Boolean).join(" · ")

    /** Where the work stands: the stages a session moves through, and which one it is in */
    function stages(data) {
      const v = data.verdict
      const plan = data.plan
      const ran = data.runs.length > 0
      const allDone = plan ? plan.steps.every((s) => ["pass", "blocked", "skipped"].includes(s.status)) : v.status === "verified"
      const building = plan?.steps.some((s) => s.building)
      const now = building ? 2 : v.status === "verified" && !v.stale ? 4 : allDone && ran ? 3 : ran ? (plan ? 2 : 3) : plan ? 1 : 0
      return { now, list: ["Goal", "Plan", "Build", "Verify", "Done"] }
    }

    function Flow({ data }) {
      const { now, list } = stages(data)
      return h(
        "div",
        { className: "kh-pg-flow", role: "list", "aria-label": "Where the work stands" },
        ...list.flatMap((label, i) => [
          i > 0 && h("span", { key: `a${i}`, className: "kh-pg-arrow", "aria-hidden": true }, "→"),
          h("span", { key: label, role: "listitem", className: `kh-pg-stage${i < now ? " done" : i === now ? " now" : ""}`, "aria-current": i === now ? "step" : undefined }, label),
        ])
      )
    }

    function Verdict({ v }) {
      const cls = v.stale ? "stale" : v.status.replace(" ", "-")
      return h("span", { className: `kh-pg-verdict ${cls}` }, v.stale ? "Changed since the last pass" : VERDICT[v.status] ?? v.status)
    }

    function Steps({ plan }) {
      const next = plan.steps.find((s) => s.status === "not started" && (s.after ?? []).every((d) => plan.steps[d - 1]?.status === "pass"))
      return plan.steps.map((s) => {
        const state = s.building ? "building" : s === next ? "next" : s.status
        const tag = s.building
          ? buildingTag(s.building)
          : s.status === "fail"
            ? `attempt ${s.attempts} of ${MAX_ATTEMPTS} failed`
            : s.status === "pass"
              ? `passed${s.attempts > 1 ? ` on run ${s.attempts}` : ""}`
              : s.status === "blocked"
                ? `blocked after ${s.attempts}`
                : s.status === "skipped"
                  ? "skipped"
                  : s === next
                    ? "next"
                    : ""
        return h(
          "div",
          { key: s.n, className: "kh-pg-step" },
          h("span", { className: `kh-pg-ico ${state}`, "aria-hidden": true }, STEP_ICON[state] ?? ""),
          h(
            "div",
            null,
            h("div", { className: "kh-pg-title" }, `${s.n}. ${s.title}`),
            h("div", { className: "kh-pg-sub" }, `Done when ${s.doneWhen}`),
            s.after?.length ? h("div", { className: "kh-pg-sub" }, `After step ${s.after.join(", ")}`) : null,
            s.building ? h("div", { className: "kh-pg-sub", role: "status" }, buildingLine(s.building)) : null
          ),
          h("span", { className: "kh-pg-tag", "aria-label": `Step ${s.n}: ${s.status}` }, tag)
        )
      })
    }

    const time = (iso) => {
      const d = new Date(iso)
      return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    }
    const secs = (ms) => (typeof ms === "number" ? (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`) : "")

    function Runs({ runs }) {
      return runs.map((r, i) =>
        h(
          "div",
          { key: `${r.at}-${i}`, className: "kh-pg-run", title: `${r.step}: ${r.status}, exit ${r.exitCode ?? "none"}` },
          h("span", { className: `kh-pg-dot ${r.status}`, "aria-hidden": true }),
          h("span", { className: "kh-pg-val" }, h("span", null, r.step), r.kind && h("span", { className: "kh-pg-dim" }, ` · ${r.kind}`), r.timedOut && h("span", { className: "kh-pg-dim" }, " · timed out")),
          h("span", { className: "kh-pg-dim kh-pg-mono" }, `${r.status === "pass" ? "exit 0" : `exit ${r.exitCode ?? "–"}`} · ${secs(r.durationMs)} · ${time(r.at)}`)
        )
      )
    }

    function ProgressBody({ useTabInfo, sessionId }) {
      const { tab } = useTabInfo()
      const visible = tab?.visible !== false
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)

      const load = useCallback(async () => {
        if (!sessionId) return
        try {
          const response = await fetch(`${API}?${new URLSearchParams({ session: sessionId })}`, { credentials: "same-origin" })
          const body = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(body.error || `Kriya answered ${response.status}.`)
          setData(body)
          setError(null)
        } catch (e) {
          setError(e.message === "Failed to fetch" ? "Kriya Harness isn't answering; is it still running?" : e.message)
        }
      }, [sessionId])

      useEffect(() => {
        if (!visible) return
        load()
        const timer = setInterval(load, REFRESH_MS)
        return () => clearInterval(timer)
      }, [visible, load])

      if (!sessionId) return h("div", { className: "kh-pg-note" }, "Start or open a session to see its progress.")
      if (error && !data) return h("div", { className: "kh-pg-error", role: "alert" }, error)
      if (!data) return h("div", { className: "kh-pg-note" }, "Loading…")
      const refresh = h("button", { type: "button", className: "kh-pg-btn", onClick: load, "aria-label": "Refresh the progress", title: "Refresh" }, svg(REFRESH))
      return h(
        "div",
        { className: "kh-pg" },
        error && h("div", { className: "kh-pg-error", role: "alert" }, error),
        h(
          "section",
          { className: "kh-pg-sec", "aria-label": "Verdict" },
          h("h3", { className: "kh-pg-h" }, "Progress", refresh),
          h(Flow, { data }),
          h(Verdict, { v: data.verdict }),
          data.plan && h("p", { className: "kh-pg-goal" }, data.plan.goal),
          h(
            "div",
            { className: "kh-pg-check" },
            data.check ? h(React.Fragment, null, "Checked by ", h("span", { className: "kh-pg-mono" }, data.check.command)) : "No check confirmed for this project: run kriya verify use in a terminal."
          ),
          data.verdict.touched && h("div", { className: "kh-pg-check" }, `The passing work changed test or check files: ${data.verdict.touched.join(", ")}.`)
        ),
        data.plan
          ? h("section", { className: "kh-pg-sec", "aria-label": "Plan" }, h("h3", { className: "kh-pg-h" }, `Plan · ${data.plan.steps.length} step${data.plan.steps.length === 1 ? "" : "s"}${data.earlierPlans ? ` · plan ${data.earlierPlans + 1}` : ""}`), h(Steps, { plan: data.plan }))
          : h("section", { className: "kh-pg-sec" }, h("h3", { className: "kh-pg-h" }, "Plan"), h("div", { className: "kh-pg-dim" }, "No plan: the agent plans with kriya_plan when a task has several parts.")),
        h(
          "section",
          { className: "kh-pg-sec", "aria-label": "Check runs" },
          h("h3", { className: "kh-pg-h" }, `Check runs${data.runs.length ? ` · ${data.runs.length}` : ""}`),
          data.runs.length ? h(Runs, { runs: data.runs }) : h("div", { className: "kh-pg-dim" }, "None yet. Only these runs decide whether the work passes.")
        )
      )
    }

    const definition = {
      id: PLUGIN,
      kind: KIND,
      priority: "extension",
      title: () => "Progress",
      guide: [{ id: "progress", order: 6, title: () => "Progress", description: () => "Goal, plan, each step's check and the verdict", icon: TabIcon }],
    }

    const inject = ["slots", "sidebarRightTabs"]

    function apply(ctx) {
      if (typeof document !== "undefined") ctx.effect(installStyles, "kriya-progress: styles")
      ctx.effect(() => ctx.sidebarRightTabs.register(definition), "kriya-progress: type")
      ctx.effect(
        () => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({ name: "sidebar.right.pane.tab", key: PLUGIN }, ProgressBody)),
        "kriya-progress: body"
      )
    }

    return { apply, inject, ProgressBody, definition, API, stages }
  },
})
