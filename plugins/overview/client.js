// The Overview tab, browser half: a right-sidebar page (the seat the Changes
// and Files tabs use) with one session at a glance: environment (this
// computer, the folder, the repository and branch), context and usage from
// DSH's token meter, the files changed, background jobs and connectors. It
// reads only this plugin's route (index.js); no DSH file is edited (HD-02).
window.__ModuleLoader__.load({
  id: "@kriya-ai/harness-overview",
  factory: (require) => {
    const React = require("react")
    const { useCallback, useEffect, useState } = React
    const h = React.createElement

    const PLUGIN = "@kriya-ai/harness-overview"
    const KIND = "kriya-overview"
    const API = "api/kriya.overview"
    const REFRESH_MS = 4000

    const CSS = `
.kh-ov { height: 100%; overflow: auto; color: var(--dsw-alias-label-primary); font-size: 13px; padding: 4px 0 16px; }
.kh-ov-sec { padding: 10px 14px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.kh-ov-sec:last-child { border-bottom: 0; }
.kh-ov-h { display: flex; align-items: center; justify-content: space-between; margin: 0 0 6px; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.kh-ov-row { display: flex; align-items: center; gap: 8px; min-height: 28px; }
.kh-ov-row svg { flex: none; color: var(--dsw-alias-label-tertiary); }
.kh-ov-val { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kh-ov-mono { font-family: var(--dsw-font-code, ui-monospace, monospace); font-size: 12px; }
.kh-ov-dim { color: var(--dsw-alias-label-tertiary); }
.kh-ov-bar { height: 6px; border-radius: 3px; background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-border-l2)); overflow: hidden; margin-top: 6px; }
.kh-ov-bar > span { display: block; height: 100%; background: var(--dsw-alias-link); }
.kh-ov-bar.warn > span { background: var(--dsw-alias-state-warn-label); }
.kh-ov-plus { color: var(--dsw-alias-state-success-primary); }
.kh-ov-minus { color: var(--dsw-alias-state-error-primary); }
.kh-ov-pill { flex: none; font-size: 11px; padding: 1px 7px; border-radius: 999px; background: var(--dsw-alias-bg-layer-1, transparent); border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.kh-ov-pill.running { color: var(--dsw-alias-link); border-color: currentColor; }
.kh-ov-pill.failed, .kh-ov-pill.killed { color: var(--dsw-alias-state-error-primary); border-color: currentColor; }
.kh-ov-btn { min-width: 44px; min-height: 44px; margin: -12px -10px -12px 0; border: 0; border-radius: 10px; background: transparent; color: inherit; cursor: pointer; display: grid; place-items: center; }
.kh-ov-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.kh-ov-btn:focus-visible { outline: 2px solid var(--dsw-alias-link); outline-offset: -2px; }
.kh-ov-switch { flex: none; width: 44px; height: 26px; padding: 3px; border: 0; border-radius: 999px; background: var(--dsw-alias-border-l2); cursor: pointer; position: relative; }
.kh-ov-switch::before { content: ""; position: absolute; inset: -9px 0; }
.kh-ov-switch > span { display: block; width: 20px; height: 20px; border-radius: 50%; background: #fff; transition: transform .15s; }
.kh-ov-switch.on { background: var(--dsw-alias-link); }
.kh-ov-switch.on > span { transform: translateX(18px); }
.kh-ov-switch:disabled { opacity: .5; cursor: default; }
.kh-ov-switch:focus-visible { outline: 2px solid var(--dsw-alias-link); outline-offset: 2px; }
.kh-ov-note2 { font-size: 12px; line-height: 1.45; color: var(--dsw-alias-label-tertiary); padding-bottom: 4px; }
.kh-ov-err { color: var(--dsw-alias-state-error-primary); }
.kh-ov-error { padding: 12px 14px; color: var(--dsw-alias-state-error-primary); }
.kh-ov-note { padding: 14px; color: var(--dsw-alias-label-tertiary); line-height: 1.5; }
`

    function installStyles() {
      const tag = document.createElement("style")
      tag.dataset.plugin = PLUGIN
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    const icon = (d, size = 16) =>
      h(
        "svg",
        { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
        ...d.map((path, i) => h("path", { key: i, d: path }))
      )
    const ICONS = {
      computer: ["M4 5h16v10H4z", "M2 19h20"],
      folder: ["M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"],
      repo: ["M6 3h11a1 1 0 0 1 1 1v14H7a2 2 0 0 0-2 2V5a2 2 0 0 1 1-2Z", "M5 20a2 2 0 0 0 2 1h11v-3"],
      branch: ["M6 3v12", "M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z", "M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z", "M18 9a9 9 0 0 1-9 9"],
      plug: ["M9 2v6", "M15 2v6", "M6 8h12v4a6 6 0 0 1-12 0Z", "M12 18v4"],
      refresh: ["M20 11a8 8 0 1 0-2.3 5.7", "M20 4v7h-7"],
      overview: ["M4 4h7v7H4z", "M13 4h7v4h-7z", "M13 10h7v10h-7z", "M4 13h7v7H4z"],
    }

    const REMOTE = "api/kriya.remote"

    function Toggle({ label, checked, disabled, onChange }) {
      return h(
        "button",
        { type: "button", role: "switch", "aria-checked": checked, "aria-label": label, disabled, className: `kh-ov-switch${checked ? " on" : ""}`, onClick: () => onChange(!checked) },
        h("span", null)
      )
    }

    // The switch beside a session's environment: on, this session shows up
    // live in Kriya and Kriya can reach this computer; no command to run
    function Remote({ sessionId }) {
      const [state, setState] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const call = useCallback(async (body) => {
        const query = new URLSearchParams({ session: sessionId })
        const response = await fetch(`${REMOTE}?${query}`, { method: body ? "POST" : "GET", credentials: "same-origin", ...(body && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) })
        const answer = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(answer.error || `Kriya Harness answered ${response.status}.`)
        setState(answer)
        setError(null)
      }, [sessionId])
      useEffect(() => {
        const read = () => call().catch((e) => setError(e.message))
        read()
        const timer = setInterval(read, REFRESH_MS)
        return () => clearInterval(timer)
      }, [call])
      const change = async (body) => {
        setBusy(true)
        await call(body).catch((e) => setError(e.message))
        setBusy(false)
      }
      if (!state) return null
      const line = !state.signedIn
        ? "Sign in with kriya login to use this."
        : state.unavailable
          ? "Not reaching Kriya: it's switched off on the server (harness.remoteControl in the Owner console). What happens now is kept and sent once it's on."
          : !state.on
            ? "Follow this session and run tasks here from the Kriya app."
            : state.daemon === "external"
              ? `On. Follow it at ${state.host}; kriya daemon is already listening.`
              : state.folderOffered
                ? `On. Follow it at ${state.host}, Kriya Harness.`
                : `On. Follow it at ${state.host}. Tasks from Kriya can't run in the home folder.`
      return Section("Remote Control", [
        h("div", { key: "t", className: "kh-ov-row" }, h("span", { className: "kh-ov-val" }, "Remote Control"), h(Toggle, { label: "Remote Control", checked: state.on, disabled: busy || !state.signedIn, onChange: (on) => change({ on }) })),
        h("div", { key: "n", className: `kh-ov-note2${state.unavailable ? " kh-ov-err" : ""}` }, line),
        error && h("div", { key: "e", className: "kh-ov-note2 kh-ov-err", role: "alert" }, error),
        state.on && h("div", { key: "s", className: "kh-ov-row" }, h("span", { className: "kh-ov-val" }, "Allow serving"), h(Toggle, { label: "Allow serving from Kriya", checked: state.serve, disabled: busy, onChange: (serve) => change({ serve }) })),
        state.on && typeof state.edit === "boolean" && h("div", { key: "e", className: "kh-ov-row" }, h("span", { className: "kh-ov-val" }, "Allow editing"), h(Toggle, { label: "Allow editing from Kriya", checked: state.edit, disabled: busy, onChange: (edit) => change({ edit }) })),
        state.on && h("div", { key: "f", className: "kh-ov-row" }, h("span", { className: "kh-ov-val" }, "Allow Full access"), h(Toggle, { label: "Allow Full access from Kriya", checked: state.fullAccess, disabled: busy, onChange: (fullAccess) => change({ fullAccess }) })),
        state.on && state.fullAccess && h("div", { key: "w", className: "kh-ov-note2 kh-ov-err" }, "Tasks from Kriya can then run with no sandbox and no questions on this computer."),
      ])
    }

    const fmt = (n) => (n === undefined || n === null ? "—" : n >= 10_000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n))
    const home = (path) => (typeof path === "string" ? path.replace(/^\/(Users|home)\/[^/]+/, "~") : path)
    const ago = (ms) => {
      if (!ms) return ""
      const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
      return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`
    }

    const Row = (glyph, value, title, extra) =>
      h("div", { className: "kh-ov-row", title }, glyph && icon(ICONS[glyph]), h("span", { className: "kh-ov-val" }, value), extra)
    const Section = (title, children, action) =>
      h("section", { className: "kh-ov-sec", "aria-label": title }, h("h3", { className: "kh-ov-h" }, title, action), children)

    function Environment({ env, action }) {
      const repo = env.repo
      return Section("Environment", [
        h(React.Fragment, { key: "c" }, Row("computer", `${env.computer} · ${env.os}`)),
        h(React.Fragment, { key: "f" }, Row("folder", h("span", { className: "kh-ov-mono" }, home(env.folder)), env.folder)),
        env.git
          ? [
              h(React.Fragment, { key: "r" }, Row("repo", repo ? (repo.github ? repo.path : `${repo.host}/${repo.path}`) : h("span", { className: "kh-ov-dim" }, "No remote"), repo ? `${repo.host}/${repo.path}` : undefined, repo?.github && h("span", { className: "kh-ov-pill" }, "GitHub"))),
              h(React.Fragment, { key: "b" }, Row("branch", env.branch ?? h("span", { className: "kh-ov-dim" }, "Detached HEAD"))),
            ]
          : h(React.Fragment, { key: "n" }, Row("repo", h("span", { className: "kh-ov-dim" }, "Not a git repository"))),
      ], action)
    }

    function Context({ data }) {
      if (!data.live) return Section("Context", h("div", { className: "kh-ov-dim" }, "Open this session to measure its context."))
      const c = data.context
      if (!c) return Section("Context", h("div", { className: "kh-ov-dim" }, "Not measured yet: it appears after the first answer."))
      const pct = c.window ? Math.min(100, Math.round((c.used / c.window) * 100)) : null
      const u = data.usage
      return Section("Context", [
        h("div", { key: "t", className: "kh-ov-row" }, h("span", { className: "kh-ov-val" }, c.window ? `${fmt(c.used)} of ${fmt(c.window)} tokens` : `${fmt(c.used)} tokens`), pct !== null && h("b", null, `${pct}%`)),
        pct !== null &&
          h("div", { key: "b", className: `kh-ov-bar${pct >= 80 ? " warn" : ""}`, role: "progressbar", "aria-label": "Context used", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": pct }, h("span", { style: { width: `${pct}%` } })),
        u && h("div", { key: "u", className: "kh-ov-row kh-ov-dim" }, `In ${fmt(u.input)} · out ${fmt(u.output)} · cache ${fmt(u.cacheRead)}`),
      ])
    }

    function Changes({ changes }) {
      if (!changes) return null
      if (!changes.count) return Section("Changes", h("div", { className: "kh-ov-dim" }, "No changes against HEAD."))
      return Section(
        `Changes · ${changes.count}${changes.truncated ? "+" : ""}`,
        changes.files.map((f) =>
          h(
            "div",
            { key: f.path, className: "kh-ov-row", title: f.path },
            h("span", { className: "kh-ov-val kh-ov-mono" }, f.path),
            f.added !== undefined && h("span", { className: "kh-ov-mono kh-ov-plus" }, `+${f.added}`),
            f.deleted !== undefined && h("span", { className: "kh-ov-mono kh-ov-minus" }, `−${f.deleted}`)
          )
        )
      )
    }

    function Jobs({ jobs }) {
      return Section(
        `Background tasks${jobs.length ? ` · ${jobs.filter((j) => j.status === "running" || j.status === "stopping").length} running` : ""}`,
        jobs.length
          ? jobs.map((j) =>
              h("div", { key: j.id, className: "kh-ov-row", title: j.label }, h("span", { className: "kh-ov-val" }, j.label || j.kind), h("span", { className: "kh-ov-dim kh-ov-mono" }, ago(j.finishedAt ?? j.startedAt)), h("span", { className: `kh-ov-pill ${j.status}` }, j.status))
            )
          : h("div", { className: "kh-ov-dim" }, "None in this session.")
      )
    }

    function Connectors({ connectors }) {
      return Section("Connectors", [
        h(React.Fragment, { key: "k" }, Row("plug", connectors.kriya ? `Kriya · ${connectors.kriya}` : h("span", { className: "kh-ov-dim" }, "Not signed in to Kriya"))),
        connectors.mcp.length
          ? connectors.mcp.map((m) => h(React.Fragment, { key: m.id }, Row("plug", m.name, undefined, h("span", { className: "kh-ov-pill" }, m.status))))
          : h("div", { key: "m", className: "kh-ov-row kh-ov-dim" }, "No MCP servers connected."),
      ])
    }

    function OverviewBody({ useTabInfo, sessionId }) {
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

      if (!sessionId) return h("div", { className: "kh-ov-note" }, "Start or open a session to see its overview.")
      if (error && !data) return h("div", { className: "kh-ov-error", role: "alert" }, error)
      if (!data) return h("div", { className: "kh-ov-note" }, "Loading…")
      const refresh = h("button", { type: "button", className: "kh-ov-btn", onClick: load, "aria-label": "Refresh the overview", title: "Refresh" }, icon(ICONS.refresh))
      return h(
        "div",
        { className: "kh-ov" },
        error && h("div", { className: "kh-ov-error", role: "alert" }, error),
        h(Environment, { key: "e", env: data.environment, action: refresh }),
        h(Remote, { key: "r", sessionId }),
        h(Context, { key: "c", data }),
        h(Changes, { key: "ch", changes: data.changes }),
        h(Jobs, { key: "j", jobs: data.jobs }),
        h(Connectors, { key: "co", connectors: data.connectors })
      )
    }

    const definition = {
      id: PLUGIN,
      kind: KIND,
      priority: "extension",
      title: () => "Overview",
      guide: [{ id: "overview", order: 5, title: () => "Overview", description: () => "Environment, context, changes, tasks and connectors", icon: () => icon(ICONS.overview, 20) }],
    }

    const inject = ["slots", "sidebarRightTabs"]

    function apply(ctx) {
      if (typeof document !== "undefined") ctx.effect(installStyles, "kriya-overview: styles")
      ctx.effect(() => ctx.sidebarRightTabs.register(definition), "kriya-overview: type")
      ctx.effect(
        () => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({ name: "sidebar.right.pane.tab", key: PLUGIN }, OverviewBody)),
        "kriya-overview: body"
      )
    }

    return { apply, inject, OverviewBody, definition, API }
  },
})
