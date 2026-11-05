// The Graph tab, browser half: the session's plan as a graph, step by step,
// from the loop's own records (GET api/kriya.progress, the Progress tab's
// route), so what it draws is what ran, never what the model said. A flow is
// designed in Kriya; this is where you watch it on the machine doing the work.
// Plain React, SVG and DSH's theme tokens; no DSH file is edited (HD-02).
window.__ModuleLoader__.load({
  id: "@kriya-ai/harness-graph",
  factory: (require) => {
    const React = require("react")
    const { useCallback, useEffect, useState } = React
    const h = React.createElement

    const PLUGIN = "@kriya-ai/harness-graph"
    const KIND = "kriya-graph"
    const API = "api/kriya.progress"
    const REFRESH_MS = 3000
    const CARD_H = 56
    const ROW = 92
    const WIDTH = 300
    const GAP = 12

    const CSS = `
.kh-gr { height: 100%; overflow: auto; color: var(--dsw-alias-label-primary); font-size: 13px; padding: 12px 14px; }
.kh-gr-goal { line-height: 1.45; margin: 0 0 10px; color: var(--dsw-alias-label-secondary); }
.kh-gr svg { display: block; width: 100%; max-width: 340px; height: auto; }
.kh-gr-card { fill: var(--dsw-alias-bg-layer-1, transparent); stroke: var(--dsw-alias-border-l2); stroke-width: 1; }
.kh-gr-card.pass { stroke: var(--dsw-alias-state-success-primary); }
.kh-gr-card.blocked { stroke: var(--dsw-alias-state-error-primary); stroke-width: 1.5; }
.kh-gr-card.fail { stroke: var(--dsw-alias-state-warn-label); }
.kh-gr-card.building { stroke: var(--dsw-alias-link); stroke-width: 1.5; }
.kh-gr-card.skipped { stroke-dasharray: 4 4; }
.kh-gr-title { fill: var(--dsw-alias-label-primary); font-size: 12.5px; font-weight: 500; }
.kh-gr-state { fill: var(--dsw-alias-label-tertiary); font-size: 11px; }
.kh-gr-state.pass { fill: var(--dsw-alias-state-success-primary); }
.kh-gr-state.blocked { fill: var(--dsw-alias-state-error-primary); }
.kh-gr-state.fail { fill: var(--dsw-alias-state-warn-label); }
.kh-gr-state.building { fill: var(--dsw-alias-link); }
.kh-gr-edge { fill: none; stroke: var(--dsw-alias-border-l2); stroke-width: 1.5; }
.kh-gr-edge.done { stroke: var(--dsw-alias-state-success-primary); }
.kh-gr-note { padding: 14px; color: var(--dsw-alias-label-tertiary); line-height: 1.5; }
.kh-gr-error { padding: 10px 14px; color: var(--dsw-alias-state-error-primary); }
`

    function installStyles() {
      const tag = document.createElement("style")
      tag.dataset.plugin = PLUGIN
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    // A step sits one row below the deepest step it needs. `after` always
    // points back (Loop v2's plan), so one pass in order is enough. Without
    // `after` the plan is a chain, as it runs.
    function layers(steps) {
      const row = new Map()
      const needs = (s, i) => (s.after?.length ? s.after : i === 0 ? [] : s.after ? [] : [steps[i - 1].n])
      steps.forEach((s, i) => row.set(s.n, Math.max(-1, ...needs(s, i).map((d) => row.get(d) ?? -1)) + 1))
      const rows = []
      for (const s of steps) (rows[row.get(s.n)] ??= []).push(s)
      const at = new Map()
      rows.forEach((list, r) => {
        const width = (WIDTH - GAP * (list.length - 1)) / list.length
        list.forEach((s, i) => at.set(s.n, { x: i * (width + GAP), y: r * ROW, width }))
      })
      const edges = steps.flatMap((s, i) => needs(s, i).map((d) => ({ from: d, to: s.n })))
      return { at, edges, height: rows.length * ROW - (ROW - CARD_H) }
    }

    const STATE = {
      pass: "Passed",
      built: "Built, not checked",
      fail: "Failing",
      blocked: "Blocked",
      skipped: "Skipped",
      "not started": "Not started",
    }
    const toneOf = (s) => (s.building ? "building" : s.status === "built" ? "" : s.status === "not started" ? "" : s.status)
    const stateOf = (s) =>
      s.building ? `Building · attempt ${s.building.attempt}` : `${STATE[s.status] ?? s.status}${s.attempts ? ` · ${s.attempts} run${s.attempts === 1 ? "" : "s"}` : ""}`
    const clip = (text, width) => {
      const room = Math.max(8, Math.floor((width - 20) / 6.6))
      return text.length > room ? `${text.slice(0, room - 1)}…` : text
    }

    function Graph({ steps }) {
      const { at, edges, height } = layers(steps)
      const byN = new Map(steps.map((s) => [s.n, s]))
      return h(
        "svg",
        { viewBox: `0 0 ${WIDTH} ${height}`, role: "img", "aria-label": `Plan: ${steps.map((s) => `${s.n}. ${s.title}, ${stateOf(s)}`).join("; ")}` },
        ...edges.map(({ from, to }) => {
          const a = at.get(from)
          const b = at.get(to)
          const [x1, y1, x2, y2] = [a.x + a.width / 2, a.y + CARD_H, b.x + b.width / 2, b.y]
          const mid = (y1 + y2) / 2
          return h("path", {
            key: `${from}-${to}`,
            className: `kh-gr-edge${byN.get(from)?.status === "pass" ? " done" : ""}`,
            d: x1 === x2 ? `M ${x1} ${y1} L ${x2} ${y2}` : `M ${x1} ${y1} L ${x1} ${mid} L ${x2} ${mid} L ${x2} ${y2}`,
          })
        }),
        ...steps.map((s) => {
          const p = at.get(s.n)
          const tone = toneOf(s)
          return h(
            "g",
            { key: s.n, transform: `translate(${p.x} ${p.y})` },
            h("title", null, `${s.title}: ${stateOf(s)}`),
            h("rect", { className: `kh-gr-card ${s.status === "skipped" ? "skipped" : tone}`, width: p.width, height: CARD_H, rx: 10 }),
            h("text", { className: "kh-gr-title", x: 10, y: 23 }, clip(`${s.n}. ${s.title}`, p.width)),
            h("text", { className: `kh-gr-state ${tone}`, x: 10, y: 41 }, clip(stateOf(s), p.width))
          )
        })
      )
    }

    function GraphBody({ useTabInfo, sessionId }) {
      const { tab } = useTabInfo()
      const visible = tab?.visible !== false
      const [plan, setPlan] = useState(undefined)
      const [error, setError] = useState(null)
      const load = useCallback(async () => {
        if (!sessionId) return
        try {
          const response = await fetch(`${API}?session=${encodeURIComponent(sessionId)}`, { credentials: "same-origin" })
          const body = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(body.error || `Kriya answered ${response.status}.`)
          setError(null)
          setPlan(body.plan)
        } catch (e) {
          setError(e.message)
        }
      }, [sessionId])
      useEffect(() => {
        if (!visible) return
        load()
        const timer = setInterval(load, REFRESH_MS)
        return () => clearInterval(timer)
      }, [visible, load])
      if (!sessionId) return h("div", { className: "kh-gr-note" }, "Start or open a session to see its graph.")
      if (error && plan === undefined) return h("div", { className: "kh-gr-error", role: "alert" }, error)
      if (plan === undefined) return h("div", { className: "kh-gr-note" }, "Loading…")
      if (!plan) return h("div", { className: "kh-gr-note" }, "No plan yet. The agent plans when a task has several parts, or design one in Kriya under Flows.")
      return h("div", { className: "kh-gr" }, plan.goal && h("p", { className: "kh-gr-goal" }, plan.goal), h(Graph, { steps: plan.steps }))
    }

    const TabIcon = () =>
      h(
        "svg",
        { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
        h("rect", { x: 3, y: 3, width: 8, height: 6, rx: 1.5 }),
        h("rect", { x: 13, y: 15, width: 8, height: 6, rx: 1.5 }),
        h("path", { d: "M7 9v3a3 3 0 0 0 3 3h3" })
      )

    const definition = {
      id: PLUGIN,
      kind: KIND,
      priority: "extension",
      title: () => "Graph",
      guide: [{ id: "graph", order: 7, title: () => "Graph", description: () => "The plan as a graph, from what really ran", icon: TabIcon }],
    }

    const inject = ["slots", "sidebarRightTabs"]

    function apply(ctx) {
      if (typeof document !== "undefined") ctx.effect(installStyles, "kriya-graph: styles")
      ctx.effect(() => ctx.sidebarRightTabs.register(definition), "kriya-graph: type")
      ctx.effect(
        () => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({ name: "sidebar.right.pane.tab", key: PLUGIN }, GraphBody)),
        "kriya-graph: body"
      )
    }

    return { apply, inject, GraphBody, definition, API, layers, stateOf }
  },
})
