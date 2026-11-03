// The Projects page, browser half: a "Projects" row in the sidebar's panel
// list and its page in the layout's main slot (the seats the Skills page
// uses). It lists the project folders the Host finds (index.js) and opens
// one the way DSH's own sidebar does: the folder becomes a workspace
// (ctx.workspaces.create), then a session opens in it
// (ctx.uiWorkspace.openWorkspace, what DSH's "New session in …" calls). No DSH file is edited (HD-02).
window.__ModuleLoader__.load({
  id: "@kriya-ai/harness-projects",
  factory: (require) => {
    const React = require("react")
    const { useCallback, useEffect, useMemo, useState, useSyncExternalStore } = React
    const h = React.createElement

    const PLUGIN = "@kriya-ai/harness-projects"
    const PANEL_ID = "kriya-projects"
    const API = "api/kriya.projects"

    /* ─────────────────────────────── styles ─────────────────────────────── */

    const CSS = `
.kh-pj { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--dsw-alias-label-primary); font-size: 14px; }
.kh-pj-head { padding: 32px 32px 18px; display: flex; flex-wrap: wrap; gap: 14px 24px; align-items: flex-end; justify-content: space-between; }
.kh-pj-title { margin: 0 0 6px; font-family: var(--dsw-font-family-brand); font-size: 30px; line-height: 36px; font-weight: 420; font-variation-settings: "opsz" 72, "SOFT" 80; letter-spacing: -0.016em; }
.kh-pj-sub { margin: 0; max-width: 60ch; color: var(--dsw-alias-label-secondary); line-height: 1.5; }
.kh-pj-tools { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.kh-pj-search { width: min(320px, 100%); box-sizing: border-box; min-height: 44px; padding: 0 14px; border-radius: 12px; border: 0; background: var(--kh-well, var(--dsw-alias-bg-layer-1)); box-shadow: inset 0 0 0 .5px var(--kh-edge, var(--dsw-alias-border-l3)); color: inherit; font: inherit; }
.kh-pj-btn { min-height: 44px; padding: 0 16px; border-radius: 12px; border: 0; background: var(--kh-chip, var(--dsw-alias-bg-layer-1)); box-shadow: var(--kh-rim, inset 0 0 0 1px var(--dsw-alias-border-l3)); color: inherit; font: inherit; font-weight: 500; cursor: pointer; transition: background-color .16s; }
.kh-pj-btn:hover:not(:disabled) { background: var(--kh-chip-hover, var(--dsw-alias-bg-layer-2)); }
.kh-pj-btn:disabled { opacity: .55; cursor: default; }
.kh-pj-btn.primary { background: var(--dsw-alias-button-info-fill); color: var(--dsw-alias-label-primary-foreground); box-shadow: inset 0 1px 0 rgb(255 255 255 / .22), 0 4px 12px -6px var(--kh-press-shadow, transparent); }
.kh-pj-btn.primary:hover:not(:disabled) { background: var(--dsw-alias-button-info-hover); }
.kh-pj-search:focus-visible, .kh-pj-btn:focus-visible { outline: 2px solid var(--dsw-alias-link); outline-offset: 2px; }
.kh-pj-body { flex: 1; min-height: 0; overflow: auto; padding: 4px 32px 32px; }
.kh-pj-group { margin: 18px 4px 8px; font-size: 12.5px; font-weight: 500; color: var(--dsw-alias-label-tertiary); font-family: var(--dsw-font-family-code, ui-monospace, monospace); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.kh-pj-list { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px; }
.kh-pj-card { display: flex; align-items: center; gap: 12px; min-height: 64px; padding: 12px 12px 12px 16px; border-radius: 16px; background: var(--kh-glass-thick, var(--dsw-alias-bg-layer-1)); box-shadow: var(--kh-rim, inset 0 0 0 1px var(--dsw-alias-border-l2)), 0 1px 2px var(--kh-shade, transparent); }
.kh-pj-main { flex: 1; min-width: 0; }
.kh-pj-name { font-weight: 560; letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kh-pj-path { margin-top: 2px; font-family: var(--dsw-font-family-code, ui-monospace, monospace); font-size: 12px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.kh-pj-tags { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
.kh-pj-tag { font-size: 11.5px; padding: 1px 8px; border-radius: 999px; background: var(--kh-well, var(--dsw-alias-bg-layer-2)); color: var(--dsw-alias-label-secondary); }
.kh-pj-tag.here { background: var(--dsw-alias-state-business-tertiary); color: var(--dsw-alias-link); }
.kh-pj-open { flex: none; min-width: 72px; }
.kh-pj-note { color: var(--dsw-alias-label-secondary); line-height: 1.55; max-width: 64ch; padding: 24px 4px; }
.kh-pj-note code { font-family: var(--dsw-font-family-code, ui-monospace, monospace); font-size: 12.5px; }
.kh-pj-error { color: var(--dsw-alias-state-error-primary); padding: 0 32px 8px; }
@media (max-width: 760px) {
  .kh-pj-head { padding: 20px 16px 12px; }
  .kh-pj-body { padding: 4px 16px 24px; }
  .kh-pj-search { width: 100%; }
  .kh-pj-tools { width: 100%; }
}
`

    function installStyles() {
      const tag = document.createElement("style")
      tag.dataset.plugin = PLUGIN
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    /* ──────────────────────────────── icon ──────────────────────────────── */

    // A folder with a spark of work in it
    function ProjectsIcon({ size = 20 }) {
      return h(
        "svg",
        { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
        h("path", { d: "M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-10Z" }),
        h("path", { d: "M10 14.5h5M12.5 12v5" })
      )
    }

    /* ──────────────────────────────── page ──────────────────────────────── */

    /** Resolves with the workspace for `path` once the client's list has it. */
    function workspaceFor(workspaces, path, timeoutMs = 10000) {
      const find = () => workspaces.list.getSnapshot().items.find((item) => item.path === path)
      return new Promise((done, fail) => {
        const now = find()
        if (now) return done(now)
        const timer = setTimeout(() => {
          stop()
          fail(new Error("The workspace didn't appear; try again."))
        }, timeoutMs)
        const stop = workspaces.list.subscribe(() => {
          const next = find()
          if (!next) return
          clearTimeout(timer)
          stop()
          done(next)
        })
      })
    }

    const since = (iso) => {
      const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000)
      if (days < 1) return "changed today"
      if (days < 2) return "changed yesterday"
      if (days < 31) return `changed ${days} days ago`
      return `changed ${new Date(iso).toLocaleDateString(undefined, { month: "short", year: "numeric" })}`
    }

    function makePage(ctx) {
      const { workspaces, uiWorkspace } = ctx
      const subscribe = (fn) => workspaces.list.subscribe(fn)
      const snapshot = () => workspaces.list.getSnapshot()

      return function ProjectsPage() {
        const [state, setState] = useState({ loading: true, projects: [], roots: [], truncated: false, error: "" })
        const [query, setQuery] = useState("")
        const [opening, setOpening] = useState("")
        const [error, setError] = useState("")
        const open = useSyncExternalStore(subscribe, snapshot)
        const openPaths = useMemo(() => new Set(open.items.map((item) => item.path)), [open])

        const load = useCallback(async () => {
          setState((s) => ({ ...s, loading: true, error: "" }))
          try {
            const response = await fetch(API, { credentials: "same-origin" })
            const data = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(data.error || `Kriya answered ${response.status}.`)
            setState({ loading: false, projects: data.projects, roots: data.roots, truncated: data.truncated, error: "" })
          } catch (e) {
            setState((s) => ({ ...s, loading: false, error: e.message }))
          }
        }, [])
        useEffect(() => void load(), [load])

        const openProject = async (project) => {
          setOpening(project.path)
          setError("")
          try {
            if (!openPaths.has(project.path)) await workspaces.create({ path: project.path })
            const workspace = await workspaceFor(workspaces, project.path)
            // DSH's own "New session in …": a blank session there, revealed
            await uiWorkspace.openWorkspace(workspace.workspaceId)
          } catch (e) {
            setError(`Couldn't open ${project.name}: ${e.message}`)
          } finally {
            setOpening("")
          }
        }

        const shown = useMemo(() => {
          const q = query.trim().toLowerCase()
          const list = q ? state.projects.filter((p) => p.name.toLowerCase().includes(q) || p.shown.toLowerCase().includes(q)) : state.projects
          const groups = new Map()
          for (const p of list) groups.set(p.root, [...(groups.get(p.root) ?? []), p])
          return [...groups]
        }, [state.projects, query])

        const card = (p) =>
          h(
            "li",
            { key: p.path, className: "kh-pj-card" },
            h(
              "div",
              { className: "kh-pj-main" },
              h("div", { className: "kh-pj-name", title: p.name }, p.name),
              h("div", { className: "kh-pj-path", title: p.path }, h("bdi", null, p.shown)),
              h(
                "div",
                { className: "kh-pj-tags" },
                p.here ? h("span", { className: "kh-pj-tag here" }, "started here") : null,
                openPaths.has(p.path) ? h("span", { className: "kh-pj-tag" }, "in sidebar") : null,
                p.git ? h("span", { className: "kh-pj-tag" }, "git") : null,
                h("span", { className: "kh-pj-tag" }, since(p.modifiedAt))
              )
            ),
            h(
              "button",
              {
                type: "button",
                className: "kh-pj-btn primary kh-pj-open",
                disabled: opening !== "",
                "aria-label": `Open ${p.name}`,
                onClick: () => openProject(p),
              },
              opening === p.path ? "Opening…" : "Open"
            )
          )

        return h(
          "section",
          { className: "kh-pj", "aria-labelledby": "kh-pj-title" },
          h(
            "header",
            { className: "kh-pj-head" },
            h(
              "div",
              null,
              h("h1", { id: "kh-pj-title", className: "kh-pj-title" }, "Projects"),
              h("p", { className: "kh-pj-sub" }, "Folders on this computer that look like projects. Open one and the agent starts a session there.")
            ),
            h(
              "div",
              { className: "kh-pj-tools" },
              h("input", {
                className: "kh-pj-search",
                type: "search",
                placeholder: "Search projects",
                "aria-label": "Search projects",
                value: query,
                onChange: (e) => setQuery(e.target.value),
              }),
              h("button", { type: "button", className: "kh-pj-btn", onClick: load, disabled: state.loading }, state.loading ? "Looking…" : "Look again")
            )
          ),
          error || state.error ? h("p", { className: "kh-pj-error", role: "alert" }, error || state.error) : null,
          h(
            "div",
            { className: "kh-pj-body" },
            !state.loading && state.projects.length === 0
              ? h(
                  "p",
                  { className: "kh-pj-note" },
                  "No project folders found in ",
                  state.roots.length ? state.roots.join(", ") : "the usual places (~/Developer, ~/Projects, ~/code and others)",
                  ". Add other folders with ",
                  h("code", null, "KRIYA_PROJECT_ROOTS"),
                  " (paths separated by colons) before starting kriya, or open any folder with the sidebar's folder button."
                )
              : shown.map(([root, list]) =>
                  h("div", { key: root }, h("div", { className: "kh-pj-group", title: root }, h("bdi", null, root)), h("ul", { className: "kh-pj-list" }, list.map(card)))
                ),
            state.truncated ? h("p", { className: "kh-pj-note" }, "Showing the first projects found; search narrows the list.") : null
          )
        )
      }
    }

    /* ─────────────────────────────── apply ──────────────────────────────── */

    const inject = ["slots", "workspaces", "uiWorkspace"]

    function apply(ctx) {
      if (typeof document !== "undefined") ctx.effect(installStyles, "kriya-projects: styles")
      const ProjectsPage = makePage(ctx)
      ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: PANEL_ID }, ProjectsPage))
      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: 4, label: "Projects" }, ProjectsIcon)
      )
    }

    return { apply, inject, makePage, ProjectsIcon, API, workspaceFor }
  },
})
