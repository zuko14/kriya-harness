// The Skills page, browser half: a "Skills" row in the sidebar's panel list
// and its page in the layout's main slot (the seats DSH's own Automation
// tasks page uses). It talks only to this plugin's routes (index.js) on the
// shared /api channel, so the browser's DSH sign-in protects it. Plain React
// and DSH's theme tokens; no DSH file is edited (HD-02).
window.__ModuleLoader__.load({
  id: "@kriya-ai/harness-skills",
  factory: (require) => {
    const React = require("react")
    const { useCallback, useEffect, useMemo, useRef, useState } = React
    const h = React.createElement

    const PLUGIN = "@kriya-ai/harness-skills"
    const PANEL_ID = "kriya-skills"
    // Browser-relative, as DSH's own routes are called (index.js ROUTES)
    const API = {
      list: "api/kriya.skills",
      read: "api/kriya.skill",
      save: "api/kriya.skill.save",
      copy: "api/kriya.skill.copy",
      create: "api/kriya.skill.create",
      unlink: "api/kriya.skill.unlink",
    }
    const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

    async function call(url, body) {
      const response = await fetch(url, {
        method: body ? "POST" : "GET",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        credentials: "same-origin",
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || `Kriya answered ${response.status}.`)
      return data
    }

    /* ─────────────────────────────── styles ─────────────────────────────── */

    const CSS = `
.kh-sk { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); font-size: 14px; }
.kh-sk-head { padding: 28px 32px 16px; display: flex; flex-wrap: wrap; gap: 12px 24px; align-items: flex-end; justify-content: space-between; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.kh-sk-title { font-size: 24px; font-weight: 600; margin: 0 0 4px; }
.kh-sk-sub { margin: 0; max-width: 62ch; color: var(--dsw-alias-label-secondary); line-height: 1.5; }
.kh-sk-meter { font-size: 12.5px; color: var(--dsw-alias-label-tertiary); margin-top: 6px; }
.kh-sk-meter.heavy { color: var(--dsw-alias-state-warn-primary); }
.kh-sk-body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(260px, 380px) 1fr; }
.kh-sk-list { min-height: 0; overflow: auto; border-right: 1px solid var(--dsw-alias-border-l2); padding: 12px; }
.kh-sk-detail { min-height: 0; overflow: auto; padding: 20px 28px 28px; display: flex; flex-direction: column; gap: 12px; }
.kh-sk-search { width: 100%; box-sizing: border-box; padding: 9px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-1); color: inherit; font: inherit; margin-bottom: 8px; }
.kh-sk-group { font-size: 11.5px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary); margin: 14px 8px 6px; }
.kh-sk-row { display: block; width: 100%; text-align: left; border: 0; background: transparent; color: inherit; font: inherit; padding: 9px 10px; border-radius: 10px; cursor: pointer; min-height: 44px; }
.kh-sk-row:hover { background: var(--dsw-specific-sidebar-nav-item-hover, var(--dsw-alias-bg-layer-1)); }
.kh-sk-row[aria-current="true"] { background: var(--dsw-specific-sidebar-nav-item-active, var(--dsw-alias-bg-layer-2)); }
.kh-sk-row:focus-visible, .kh-sk-btn:focus-visible, .kh-sk-search:focus-visible, .kh-sk-input:focus-visible { outline: 2px solid var(--dsw-alias-link); outline-offset: 1px; }
.kh-sk-name { font-family: var(--dsw-font-code, ui-monospace, monospace); font-size: 13px; }
.kh-sk-desc { color: var(--dsw-alias-label-secondary); font-size: 12.5px; line-height: 1.45; margin-top: 2px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.kh-sk-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.kh-sk-tag { font-size: 11.5px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-secondary); }
.kh-sk-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.kh-sk-btn { min-height: 36px; padding: 0 14px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-1); color: inherit; font: inherit; cursor: pointer; }
.kh-sk-btn:disabled { opacity: 0.5; cursor: default; }
.kh-sk-btn.primary { background: var(--dsw-alias-button-info-fill, var(--dsw-alias-link)); border-color: transparent; color: var(--dsw-alias-label-primary-foreground, #fff); }
.kh-sk-btn.danger { color: var(--dsw-alias-state-error-primary); }
.kh-sk-path { font-family: var(--dsw-font-code, ui-monospace, monospace); font-size: 12px; color: var(--dsw-alias-label-tertiary); word-break: break-all; }
.kh-sk-pre, .kh-sk-editor { margin: 0; flex: 1; min-height: 320px; box-sizing: border-box; width: 100%; padding: 14px 16px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: inherit; font-family: var(--dsw-font-code, ui-monospace, monospace); font-size: 12.5px; line-height: 1.55; white-space: pre-wrap; overflow: auto; }
.kh-sk-editor { resize: vertical; }
.kh-sk-input { width: 100%; box-sizing: border-box; padding: 9px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-1); color: inherit; font: inherit; }
.kh-sk-label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.kh-sk-error { color: var(--dsw-alias-state-error-primary); font-size: 13px; }
.kh-sk-note { color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 1.5; }
.kh-sk-problem { color: var(--dsw-alias-state-warn-primary); font-size: 12.5px; padding: 4px 10px; line-height: 1.45; }
.kh-sk-empty { color: var(--dsw-alias-label-tertiary); padding: 24px 10px; line-height: 1.5; }
@media (max-width: 760px) {
  .kh-sk-head { padding: 20px 16px 12px; }
  .kh-sk-body { grid-template-columns: 1fr; grid-template-rows: minmax(200px, 40%) 1fr; }
  .kh-sk-list { border-right: 0; border-bottom: 1px solid var(--dsw-alias-border-l2); }
  .kh-sk-detail { padding: 16px; }
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

    // A book with a spark: guidance the agent reads
    function SkillsIcon({ size = 20 }) {
      return h(
        "svg",
        { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
        h("path", { d: "M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5v-15Z" }),
        h("path", { d: "M4 20.5A2.5 2.5 0 0 0 6.5 21H19" }),
        h("path", { d: "M12 7.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1Z" })
      )
    }

    /* ──────────────────────────────── page ──────────────────────────────── */

    function tags(skill) {
      const out = []
      if (skill.linked) out.push("linked")
      else if (skill.source === "project-dsh" || skill.source === "project-agents") out.push("this project")
      else out.push("yours")
      if (!skill.modelInvocable) out.push("only with /" + skill.name)
      if (!skill.userInvocable) out.push("agent only")
      return out
    }

    function SkillsPage() {
      const [page, setPage] = useState(null)
      const [loadError, setLoadError] = useState(null)
      const [query, setQuery] = useState("")
      const [selected, setSelected] = useState(null)
      const [file, setFile] = useState(null)
      const [mode, setMode] = useState("view")
      const [draft, setDraft] = useState("")
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [notice, setNotice] = useState(null)
      const [newName, setNewName] = useState("")
      const [newDescription, setNewDescription] = useState("")
      const editorRef = useRef(null)

      const load = useCallback(async () => {
        setLoadError(null)
        try {
          setPage(await call(API.list))
        } catch (e) {
          setLoadError(e.message)
        }
      }, [])
      useEffect(() => {
        load()
      }, [load])

      const open = useCallback(async (name) => {
        setSelected(name)
        setMode("view")
        setError(null)
        setNotice(null)
        setFile(null)
        try {
          setFile(await call(`${API.read}?${new URLSearchParams({ name })}`))
        } catch (e) {
          setError(e.message)
        }
      }, [])

      const act = useCallback(
        async (work, done) => {
          setBusy(true)
          setError(null)
          setNotice(null)
          try {
            const result = await work()
            await load()
            done?.(result)
          } catch (e) {
            setError(e.message)
          } finally {
            setBusy(false)
          }
        },
        [load]
      )

      const save = () =>
        act(
          () => call(API.save, { name: selected, content: draft }),
          (saved) => {
            setFile(saved)
            setMode("view")
            setNotice("Saved. The agent uses this version from its next step.")
          }
        )
      const copy = () =>
        act(
          () => call(API.copy, { name: selected }),
          (copied) => {
            setFile(copied)
            setNotice("This is your own copy now; edit it freely. Updates to its source no longer reach it.")
          }
        )
      const unlink = () => {
        if (!window.confirm(`Unlink ${selected}? The source folder stays where it is.`)) return
        act(
          () => call(API.unlink, { name: selected }),
          () => {
            setSelected(null)
            setFile(null)
            setNotice(null)
          }
        )
      }
      const create = (event) => {
        event.preventDefault()
        act(
          () => call(API.create, { name: newName, description: newDescription }),
          (created) => {
            setSelected(created.name)
            setFile(created)
            setDraft(created.content)
            setMode("edit")
            setNewName("")
            setNewDescription("")
          }
        )
      }

      useEffect(() => {
        if (mode === "edit") editorRef.current?.focus()
      }, [mode])

      const shown = useMemo(() => {
        if (!page) return []
        const q = query.trim().toLowerCase()
        return page.skills.filter((s) => !q || s.name.includes(q) || s.description.toLowerCase().includes(q))
      }, [page, query])
      const groups = useMemo(() => {
        const out = new Map()
        for (const s of shown) out.set(s.where, [...(out.get(s.where) ?? []), s])
        return [...out]
      }, [shown])

      const header = h(
        "header",
        { className: "kh-sk-head" },
        h(
          "div",
          null,
          h("h1", { className: "kh-sk-title" }, "Skills"),
          h(
            "p",
            { className: "kh-sk-sub" },
            "Guidance your agent reads before it works. It picks a skill on its own when a job matches the description, or you name one with /skill-name in a message. A skill never adds a tool or skips an approval."
          ),
          page &&
            h(
              "div",
              { className: page.heavy ? "kh-sk-meter heavy" : "kh-sk-meter" },
              `${page.skills.length} skills · the list costs about ${page.catalogTokens.toLocaleString()} tokens on every request`,
              page.heavy ? " · that's a lot: remove the ones you don't use" : ""
            )
        ),
        h(
          "button",
          { className: "kh-sk-btn primary", type: "button", onClick: () => { setSelected(null); setFile(null); setMode("new"); setError(null); setNotice(null) } },
          "New skill"
        )
      )

      const problems =
        page &&
        [
          ...page.broken.map((name) => `${name}: broken link, its folder is gone`),
          ...page.warnings.map((w) => `Not loaded: ${w}`),
          ...page.shadowed.map((s) => `${s.name} in ${s.where} is hidden by a skill with the same name`),
        ].map((text, i) => h("div", { key: `p${i}`, className: "kh-sk-problem" }, text))

      const list = h(
        "nav",
        { className: "kh-sk-list", "aria-label": "Skills" },
        h("input", {
          className: "kh-sk-search",
          type: "search",
          placeholder: "Search skills",
          "aria-label": "Search skills",
          value: query,
          onChange: (e) => setQuery(e.target.value),
        }),
        loadError && h("div", { className: "kh-sk-error" }, loadError, " ", h("button", { className: "kh-sk-btn", type: "button", onClick: load }, "Try again")),
        !page && !loadError && h("div", { className: "kh-sk-empty" }, "Loading skills…"),
        page && page.skills.length === 0 &&
          h("div", { className: "kh-sk-empty" }, "No skills yet. Create one here, or add a folder of them in a terminal: kriya skills link <folder>."),
        page && page.skills.length > 0 && shown.length === 0 && h("div", { className: "kh-sk-empty" }, "No skill matches."),
        ...groups.map(([where, skills]) =>
          h(
            "div",
            { key: where },
            h("div", { className: "kh-sk-group" }, where),
            ...skills.map((s) =>
              h(
                "button",
                { key: s.name, type: "button", className: "kh-sk-row", "aria-label": `${s.name}: ${s.description}`, "aria-current": selected === s.name ? "true" : undefined, onClick: () => open(s.name) },
                h("div", { className: "kh-sk-name" }, s.name),
                h("div", { className: "kh-sk-desc" }, s.description)
              )
            )
          )
        ),
        problems && problems.length > 0 && h("div", null, h("div", { className: "kh-sk-group" }, "Needs attention"), ...problems)
      )

      let detail
      if (mode === "new") {
        const nameOk = SKILL_NAME.test(newName)
        detail = h(
          "form",
          { className: "kh-sk-detail", onSubmit: create },
          h("h2", { className: "kh-sk-title" }, "New skill"),
          h("p", { className: "kh-sk-note" }, "Saved in your Kriya skills folder. The description is how the agent decides when to use it, so say when it applies."),
          h(
            "label",
            { className: "kh-sk-label" },
            "Name (lowercase words joined by dashes)",
            h("input", { className: "kh-sk-input", value: newName, onChange: (e) => setNewName(e.target.value.trim()), placeholder: "release-notes", required: true, "aria-invalid": newName && !nameOk ? "true" : undefined })
          ),
          newName && !nameOk && h("div", { className: "kh-sk-error" }, "Use lowercase letters, digits and single dashes, like release-notes."),
          h(
            "label",
            { className: "kh-sk-label" },
            "When should the agent use it?",
            h("textarea", { className: "kh-sk-input", rows: 4, value: newDescription, onChange: (e) => setNewDescription(e.target.value), placeholder: "Use when writing release notes from merged pull requests: group by feature, plain words, link each PR.", required: true })
          ),
          h(
            "div",
            { className: "kh-sk-actions" },
            h("button", { className: "kh-sk-btn primary", type: "submit", disabled: busy || !nameOk || newDescription.trim().length < 10 }, busy ? "Creating…" : "Create and edit"),
            h("button", { className: "kh-sk-btn", type: "button", onClick: () => setMode("view") }, "Cancel")
          ),
          error && h("div", { className: "kh-sk-error", role: "alert" }, error)
        )
      } else if (!selected) {
        detail = h(
          "section",
          { className: "kh-sk-detail" },
          h("p", { className: "kh-sk-note" }, "Choose a skill to read it. Skills you own can be edited here; a linked one (from a plugin or a repository) can become your own copy first, so its source stays untouched."),
          notice && h("div", { className: "kh-sk-note", role: "status" }, notice),
          error && h("div", { className: "kh-sk-error", role: "alert" }, error)
        )
      } else {
        const info = file
        detail = h(
          "section",
          { className: "kh-sk-detail", "aria-label": selected },
          h("h2", { className: "kh-sk-title kh-sk-name" }, selected),
          info && h("div", { className: "kh-sk-tags" }, ...tags(info).map((t) => h("span", { key: t, className: "kh-sk-tag" }, t)), h("span", { className: "kh-sk-tag" }, info.where)),
          info && h("div", { className: "kh-sk-path" }, info.linked ? `${info.path} → ${info.linkTarget ?? "missing"}` : info.path),
          info &&
            h(
              "div",
              { className: "kh-sk-actions" },
              mode === "edit"
                ? [
                    h("button", { key: "save", className: "kh-sk-btn primary", type: "button", disabled: busy, onClick: save }, busy ? "Saving…" : "Save"),
                    h("button", { key: "cancel", className: "kh-sk-btn", type: "button", disabled: busy, onClick: () => { setMode("view"); setError(null) } }, "Cancel"),
                  ]
                : [
                    info.editable && h("button", { key: "edit", className: "kh-sk-btn primary", type: "button", onClick: () => { setDraft(info.content); setMode("edit"); setNotice(null) } }, "Edit"),
                    info.canCopy && h("button", { key: "copy", className: "kh-sk-btn", type: "button", disabled: busy, onClick: copy }, "Make my own copy"),
                    info.userInvocable &&
                      h("button", { key: "use", className: "kh-sk-btn", type: "button", onClick: () => { navigator.clipboard?.writeText(`/${selected} `); setNotice(`Copied /${selected}: paste it at the start of a message.`) } }, "Copy /" + selected),
                    info.canCopy && h("button", { key: "unlink", className: "kh-sk-btn danger", type: "button", disabled: busy, onClick: unlink }, "Unlink"),
                  ]
            ),
          notice && h("div", { className: "kh-sk-note", role: "status" }, notice),
          error && h("div", { className: "kh-sk-error", role: "alert" }, error),
          !info && !error && h("div", { className: "kh-sk-empty" }, "Loading…"),
          info &&
            (mode === "edit"
              ? h("textarea", {
                  ref: editorRef,
                  className: "kh-sk-editor",
                  value: draft,
                  spellCheck: false,
                  "aria-label": `${selected} SKILL.md`,
                  onChange: (e) => setDraft(e.target.value),
                  onKeyDown: (e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
                      e.preventDefault()
                      save()
                    }
                  },
                })
              : h("pre", { className: "kh-sk-pre", tabIndex: 0, "aria-label": `${selected} SKILL.md` }, info.content))
        )
      }

      return h("div", { className: "kh-sk" }, header, h("div", { className: "kh-sk-body" }, list, detail))
    }

    /* ─────────────────────────────── apply ─────────────────────────────── */

    const inject = ["slots"]

    function apply(ctx) {
      if (typeof document !== "undefined") ctx.effect(installStyles, "kriya-skills: styles")
      ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: PANEL_ID }, SkillsPage))
      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: 5, label: "Skills" }, SkillsIcon)
      )
    }

    return { apply, inject, SkillsPage, SkillsIcon, API }
  },
})
