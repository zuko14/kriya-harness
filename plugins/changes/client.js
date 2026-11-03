// The Changes tab, browser half: a right-sidebar page (the seat DSH's own
// Files tab uses: ctx.sidebarRightTabs.register plus the keyed
// sidebar.right.pane.tab body) listing every file changed in the session's
// folder against HEAD, with lines added and removed, and each file's diff.
// It talks only to this plugin's routes (index.js) on the shared /api
// channel. Plain React and DSH's theme tokens; no DSH file is edited (HD-02).
window.__ModuleLoader__.load({
  id: "@kriya-ai/harness-changes",
  factory: (require) => {
    const React = require("react")
    const { useCallback, useEffect, useState } = React
    const h = React.createElement

    const PLUGIN = "@kriya-ai/harness-changes"
    const KIND = "kriya-changes"
    const API = { list: "api/kriya.changes", diff: "api/kriya.changes.diff" }
    // While the tab is on screen; a hidden tab doesn't poll
    const REFRESH_MS = 4000

    async function call(url) {
      const response = await fetch(url, { credentials: "same-origin" })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || `Kriya answered ${response.status}.`)
      return data
    }

    const CSS = `
.kh-ch { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--dsw-alias-label-primary); font-size: 13px; }
.kh-ch-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.kh-ch-sum { flex: 1; min-width: 0; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kh-ch-sum b { color: var(--dsw-alias-label-primary); font-weight: 600; }
.kh-ch-btn { min-width: 44px; min-height: 44px; border: 0; border-radius: 10px; background: transparent; color: inherit; font: inherit; cursor: pointer; display: grid; place-items: center; }
.kh-ch-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.kh-ch-btn:focus-visible, .kh-ch-row:focus-visible { outline: 2px solid var(--dsw-alias-link); outline-offset: -2px; }
.kh-ch-list { overflow: auto; flex: 0 1 auto; max-height: 45%; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.kh-ch-list.full { max-height: none; flex: 1; border-bottom: 0; }
.kh-ch-row { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 36px; padding: 4px 12px; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.kh-ch-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.kh-ch-row[aria-current="true"] { background: var(--dsw-specific-sidebar-nav-item-active, var(--dsw-alias-interactive-bg-active)); }
.kh-ch-st { flex: none; width: 18px; height: 18px; border-radius: 5px; display: grid; place-items: center; font-size: 11px; font-weight: 700; font-family: var(--dsw-font-code, ui-monospace, monospace); }
.kh-ch-st.added { color: var(--dsw-alias-state-success-primary); background: var(--dsw-alias-state-success-tertiary); }
.kh-ch-st.deleted, .kh-ch-st.conflict { color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-interactive-bg-hover-danger); }
.kh-ch-st.modified, .kh-ch-st.renamed { color: var(--dsw-alias-state-warn-label); background: var(--dsw-alias-state-warn-tertiary); }
.kh-ch-path { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left; font-family: var(--dsw-font-code, ui-monospace, monospace); font-size: 12px; }
.kh-ch-path span { direction: ltr; unicode-bidi: plaintext; }
.kh-ch-dir { color: var(--dsw-alias-label-tertiary); }
.kh-ch-n { flex: none; font-family: var(--dsw-font-code, ui-monospace, monospace); font-size: 11.5px; }
.kh-ch-plus { color: var(--dsw-alias-state-success-primary); }
.kh-ch-minus { color: var(--dsw-alias-state-error-primary); margin-left: 6px; }
.kh-ch-diff { flex: 1; min-height: 0; overflow: auto; margin: 0; padding: 8px 0; font-family: var(--dsw-font-code, ui-monospace, monospace); font-size: 12px; line-height: 1.55; }
.kh-ch-line { display: block; padding: 0 12px; white-space: pre; min-width: max-content; }
.kh-ch-line.add { background: var(--dsw-alias-state-success-tertiary); }
.kh-ch-line.del { background: var(--dsw-alias-interactive-bg-hover-danger); }
.kh-ch-line.hunk { color: var(--dsw-alias-label-tertiary); background: var(--dsw-alias-bg-layer-1); }
.kh-ch-line.meta { color: var(--dsw-alias-label-tertiary); }
.kh-ch-note { padding: 16px 12px; color: var(--dsw-alias-label-tertiary); line-height: 1.5; }
.kh-ch-error { padding: 12px; color: var(--dsw-alias-state-error-primary); }
`

    function installStyles() {
      const tag = document.createElement("style")
      tag.dataset.plugin = PLUGIN
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    // Two pages with a plus and a minus: what changed
    function ChangesIcon({ size = 20 }) {
      return h(
        "svg",
        { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
        h("path", { d: "M8 3h7l4 4v11a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" }),
        h("path", { d: "M10 9.5h5M12.5 7v5" }),
        h("path", { d: "M10 15.5h5" })
      )
    }

    function RefreshIcon() {
      return h(
        "svg",
        { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
        h("path", { d: "M20 11a8 8 0 1 0-2.3 5.7" }),
        h("path", { d: "M20 4v7h-7" })
      )
    }

    const LETTER = { added: "A", modified: "M", deleted: "D", renamed: "R", conflict: "U" }

    function splitPath(path) {
      const at = path.lastIndexOf("/")
      return at < 0 ? ["", path] : [path.slice(0, at + 1), path.slice(at + 1)]
    }

    function lineClass(line) {
      if (line.startsWith("@@")) return "kh-ch-line hunk"
      if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(line)) return "kh-ch-line meta"
      if (line.startsWith("+")) return "kh-ch-line add"
      if (line.startsWith("-")) return "kh-ch-line del"
      return "kh-ch-line"
    }

    function ChangesBody({ useTabInfo, sessionId }) {
      const { tab } = useTabInfo()
      const visible = tab?.visible !== false
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [selected, setSelected] = useState(null)
      const [diff, setDiff] = useState(null)
      const [diffError, setDiffError] = useState(null)

      const load = useCallback(async () => {
        if (!sessionId) return
        try {
          setData(await call(`${API.list}?${new URLSearchParams({ session: sessionId })}`))
          setError(null)
        } catch (e) {
          setError(e.message)
        }
      }, [sessionId])

      useEffect(() => {
        if (!visible) return
        load()
        const timer = setInterval(load, REFRESH_MS)
        return () => clearInterval(timer)
      }, [load, visible])

      // The open file's diff follows the list: reloaded when its counts move
      const current = data?.files?.find((f) => f.path === selected)
      const stamp = current ? `${current.status}:${current.added}:${current.deleted}` : null
      useEffect(() => {
        if (!selected || !stamp) {
          setDiff(null)
          return
        }
        let gone = false
        call(`${API.diff}?${new URLSearchParams({ session: sessionId, path: selected })}`).then(
          (d) => !gone && (setDiff(d), setDiffError(null)),
          (e) => !gone && setDiffError(e.message)
        )
        return () => {
          gone = true
        }
      }, [selected, stamp, sessionId])

      const head = h(
        "div",
        { className: "kh-ch-head" },
        h(
          "div",
          { className: "kh-ch-sum", role: "status" },
          data?.git
            ? [
                h("b", { key: "n" }, `${data.files.length}${data.truncated ? "+" : ""} file${data.files.length === 1 ? "" : "s"}`),
                " changed ",
                h("span", { key: "a", className: "kh-ch-plus" }, `+${data.added}`),
                h("span", { key: "d", className: "kh-ch-minus" }, `−${data.deleted}`),
                data.branch ? ` · ${data.branch}` : "",
              ]
            : "Changes"
        ),
        h("button", { className: "kh-ch-btn", type: "button", onClick: load, "aria-label": "Refresh changes", title: "Refresh" }, h(RefreshIcon))
      )

      let body
      if (error) body = h("div", { className: "kh-ch-error", role: "alert" }, error)
      else if (!data) body = h("div", { className: "kh-ch-note" }, "Reading changes…")
      else if (!data.git) body = h("div", { className: "kh-ch-note" }, "This folder isn't a git repository, so there's nothing to compare against. Run git init here to track what the agent changes.")
      else if (data.files.length === 0) body = h("div", { className: "kh-ch-note" }, "No changes against the last commit.")
      else
        body = [
          h(
            "nav",
            { key: "list", className: selected ? "kh-ch-list" : "kh-ch-list full", "aria-label": "Changed files" },
            ...data.files.map((f) => {
              const [dir, base] = splitPath(f.path)
              return h(
                "button",
                {
                  key: f.path,
                  type: "button",
                  className: "kh-ch-row",
                  "aria-current": selected === f.path ? "true" : undefined,
                  "aria-label": `${f.path}, ${f.status}${f.binary ? ", binary" : f.added === undefined ? "" : `, ${f.added} added, ${f.deleted} removed`}`,
                  title: f.from ? `${f.from} → ${f.path}` : f.path,
                  onClick: () => setSelected(selected === f.path ? null : f.path),
                },
                h("span", { className: `kh-ch-st ${f.status}`, "aria-hidden": true }, LETTER[f.status] ?? "M"),
                h("span", { className: "kh-ch-path" }, h("span", null, h("span", { className: "kh-ch-dir" }, dir), base)),
                h(
                  "span",
                  { className: "kh-ch-n", "aria-hidden": true },
                  f.binary ? "binary" : f.added === undefined ? "" : [h("span", { key: "a", className: "kh-ch-plus" }, `+${f.added}`), h("span", { key: "d", className: "kh-ch-minus" }, `−${f.deleted}`)]
                )
              )
            })
          ),
          selected &&
            (diffError
              ? h("div", { key: "e", className: "kh-ch-error", role: "alert" }, diffError)
              : !diff
                ? h("div", { key: "l", className: "kh-ch-note" }, "Loading the diff…")
                : diff.binary
                  ? h("div", { key: "b", className: "kh-ch-note" }, "A binary file: no line diff.")
                  : h(
                      "pre",
                      { key: "d", className: "kh-ch-diff", tabIndex: 0, "aria-label": `Diff of ${selected}` },
                      ...diff.diff.split("\n").map((line, i) => h("span", { key: i, className: lineClass(line) }, line || " ")),
                      diff.truncated && h("span", { className: "kh-ch-line meta" }, "… the rest of this diff is too long to show here.")
                    )),
        ]

      return h("div", { className: "kh-ch" }, head, body)
    }

    const definition = {
      id: PLUGIN,
      kind: KIND,
      priority: "extension",
      title: () => "Changes",
      guide: [{ id: "changes", order: 15, title: () => "Changes", description: () => "What changed in this folder, file by file", icon: ChangesIcon }],
    }

    const inject = ["slots", "sidebarRightTabs"]

    function apply(ctx) {
      if (typeof document !== "undefined") ctx.effect(installStyles, "kriya-changes: styles")
      ctx.effect(() => ctx.sidebarRightTabs.register(definition), "kriya-changes: type")
      ctx.effect(
        () => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({ name: "sidebar.right.pane.tab", key: PLUGIN }, ChangesBody)),
        "kriya-changes: body"
      )
    }

    return { apply, inject, ChangesBody, definition, API, lineClass }
  },
})
