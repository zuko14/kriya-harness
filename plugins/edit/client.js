// The Editing Studio row, browser half: an "Editing Studio" row in the sidebar's
// panel list (the seat the Projects page uses) and its page in the main slot. The
// page asks the node half for a one-time link and navigates the whole tab to the
// Studio (STUDIO_APP_AND_BROWSER §1); the Studio's "Kriya Harness" link comes back.
// Coming back, the page waits for a click instead of leaving again at once.
window.__ModuleLoader__.load({
  id: "@kriya-ai/harness-edit",
  factory: (require) => {
    const React = require("react")
    const { useCallback, useEffect, useState } = React
    const h = React.createElement

    const PLUGIN = "@kriya-ai/harness-edit"
    const PANEL_ID = "kriya-edit"
    const API = "api/kriya.edit.launch"
    const LEFT = "kriya-edit-left"

    const CSS = `
.kh-ed { display: flex; flex-direction: column; gap: 14px; padding: 32px; color: var(--dsw-alias-label-primary); font-size: 14px; max-width: 64ch; }
.kh-ed-title { margin: 0; font-family: var(--dsw-font-family-brand); font-size: 30px; line-height: 36px; font-weight: 420; letter-spacing: -0.016em; }
.kh-ed-note { margin: 0; color: var(--dsw-alias-label-secondary); line-height: 1.5; }
.kh-ed-error { margin: 0; color: var(--dsw-alias-state-error-primary); }
.kh-ed-btn { align-self: flex-start; min-height: 44px; padding: 0 16px; border-radius: 12px; border: 0; background: var(--dsw-alias-button-info-fill); color: var(--dsw-alias-label-primary-foreground); font: inherit; font-weight: 500; cursor: pointer; }
.kh-ed-btn:hover:not(:disabled) { background: var(--dsw-alias-button-info-hover); }
.kh-ed-btn:disabled { opacity: .55; cursor: default; }
.kh-ed-btn:focus-visible { outline: 2px solid var(--dsw-alias-link); outline-offset: 2px; }
@media (max-width: 760px) { .kh-ed { padding: 20px 16px; } }
`

    function installStyles() {
      const tag = document.createElement("style")
      tag.dataset.plugin = PLUGIN
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    // A frame of film with a cut through it
    function EditIcon({ size = 20 }) {
      return h(
        "svg",
        { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
        h("rect", { x: 3, y: 5, width: 18, height: 14, rx: 2.5 }),
        h("path", { d: "M7 5v14M17 5v14M3 9.5h4M3 14.5h4M17 9.5h4M17 14.5h4M12 9l-1.5 6" })
      )
    }

    const seen = (key) => {
      try {
        const value = sessionStorage.getItem(key)
        sessionStorage.removeItem(key)
        return value !== null
      } catch {
        return false
      }
    }

    /** Asks for a link and goes there. @returns {Promise<string | null>} an error to show, or null */
    async function open(fetchImpl = fetch, go = (url) => window.location.assign(url)) {
      try {
        const response = await fetchImpl(API, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
        const value = await response.json().catch(() => ({}))
        if (!response.ok || typeof value.url !== "string") return value.error ?? "The Editing Studio couldn't start."
        try {
          sessionStorage.setItem(LEFT, "1")
        } catch {
          // Without storage, coming back simply opens it again
        }
        go(value.url)
        return null
      } catch {
        return "Kriya Harness couldn't reach the Editing Studio."
      }
    }

    function EditPage() {
      const [returned] = useState(() => seen(LEFT))
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(!returned)
      const start = useCallback(() => {
        setBusy(true)
        setError(null)
        open().then((problem) => {
          if (problem) {
            setError(problem)
            setBusy(false)
          }
        })
      }, [])
      useEffect(() => {
        if (!returned) start()
      }, [returned, start])
      return h(
        "div",
        { className: "kh-ed" },
        h("h1", { className: "kh-ed-title" }, "Editing Studio"),
        h("p", { className: "kh-ed-note" }, "Edit video on this computer: your footage stays here. The Studio opens in this tab; its Kriya Harness link brings you back."),
        error ? h("p", { className: "kh-ed-error", role: "alert" }, error) : null,
        h("button", { type: "button", className: "kh-ed-btn", onClick: start, disabled: busy }, busy ? "Opening…" : "Open the Editing Studio")
      )
    }

    const inject = ["slots"]

    function apply(ctx) {
      if (typeof document !== "undefined") ctx.effect(installStyles, "kriya-edit: styles")
      ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: PANEL_ID }, EditPage))
      ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: 5, label: "Editing Studio" }, EditIcon))
    }

    return { apply, inject, EditPage, EditIcon, open, API, PANEL_ID }
  },
})
