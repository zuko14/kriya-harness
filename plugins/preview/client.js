// The Preview tab (browser stage 1): a right-sidebar page that shows an app
// running on this computer (a dev server on localhost) in a frame, with an
// address bar, reload and "open in your browser". Only loopback addresses
// (localhost, *.localhost, 127.0.0.1, [::1]) over http or https are framed,
// and never the Web UI's own port, so a framed page can't reach Kriya
// Harness itself. A site that refuses to be framed opens in the person's
// own browser instead. Plain React and DSH's theme tokens; no DSH file is
// edited (HD-02). Stage 2 (a real browser the agent can test with) shares
// this tab later.
window.__ModuleLoader__.load({
  id: "@kriya-ai/harness-preview",
  factory: (require) => {
    const React = require("react")
    const { useEffect, useRef, useState } = React
    const h = React.createElement

    const PLUGIN = "@kriya-ai/harness-preview"
    const KIND = "kriya-preview"
    const STORE = "kriya-preview:last"

    /**
     * The address to frame, or an error sentence. `self` is the Web UI's own
     * location, so its port is refused.
     */
    function previewUrl(input, self) {
      let text = String(input ?? "").trim()
      if (!text) return { error: "Type a local address, e.g. localhost:3000." }
      if (/^\d{2,5}(\/|$)/.test(text)) text = `localhost:${text}`
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`
      let url
      try {
        url = new URL(text)
      } catch {
        return { error: "That isn't an address." }
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") return { error: "Only http and https addresses." }
      if (url.username || url.password) return { error: "Addresses with a user name or password aren't framed." }
      const host = url.hostname.replace(/^\[|\]$/g, "")
      const loopback = host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host)
      if (!loopback) return { error: "Preview shows apps on this computer only (localhost). Open other sites in your browser." }
      const port = url.port || (url.protocol === "https:" ? "443" : "80")
      const selfPort = self?.port || (self?.protocol === "https:" ? "443" : "80")
      const selfLoopback = self && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(self.hostname)
      if (selfLoopback && port === selfPort) return { error: "That's Kriya Harness itself; preview your app's port instead." }
      return { url: url.href }
    }

    const CSS = `
.kh-pv { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--dsw-alias-label-primary); font-size: 13px; }
.kh-pv-bar { display: flex; align-items: center; gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.kh-pv-form { flex: 1; min-width: 0; display: flex; }
.kh-pv-input { flex: 1; min-width: 0; min-height: 36px; padding: 0 10px; border-radius: 9px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1, transparent); color: inherit; font: inherit; font-family: var(--dsw-font-code, ui-monospace, monospace); font-size: 12px; }
.kh-pv-input:focus-visible { outline: 2px solid var(--dsw-alias-link); outline-offset: 0; }
.kh-pv-btn { min-width: 44px; min-height: 44px; border: 0; border-radius: 10px; background: transparent; color: inherit; cursor: pointer; display: grid; place-items: center; }
.kh-pv-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.kh-pv-btn:disabled { opacity: 0.4; cursor: default; }
.kh-pv-btn:focus-visible { outline: 2px solid var(--dsw-alias-link); outline-offset: -2px; }
.kh-pv-frame { flex: 1; min-height: 0; width: 100%; border: 0; background: #fff; }
.kh-pv-note { padding: 16px 14px; color: var(--dsw-alias-label-tertiary); line-height: 1.55; }
.kh-pv-error { padding: 8px 12px; color: var(--dsw-alias-state-error-primary); border-bottom: 1px solid var(--dsw-alias-border-l2); }
.kh-pv-modes { display: flex; gap: 4px; padding: 6px 8px 0; }
.kh-pv-mode { min-height: 32px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; }
.kh-pv-mode[aria-pressed="true"] { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-link); font-weight: 600; }
.kh-pv-mode:focus-visible { outline: 2px solid var(--dsw-alias-link); outline-offset: 1px; }
.kh-pv-live { flex: 1; min-height: 0; overflow: auto; background: var(--dsw-alias-bg-layer-1, #111); display: flex; align-items: flex-start; justify-content: center; }
.kh-pv-shot { width: 100%; height: auto; display: block; cursor: pointer; outline: none; }
.kh-pv-shot:focus-visible { box-shadow: inset 0 0 0 2px var(--dsw-alias-link); }
.kh-pv-url { padding: 4px 10px; font-family: var(--dsw-font-code, ui-monospace, monospace); font-size: 11.5px; color: var(--dsw-alias-label-tertiary); border-bottom: 1px solid var(--dsw-alias-border-l2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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
    const TabIcon = ({ size = 20 }) => svg(["M3 5h18v14H3z", "M3 9h18", "M6 7h.01", "M9 7h.01"], size)
    const RELOAD = ["M20 11a8 8 0 1 0-2.3 5.7", "M20 4v7h-7"]
    const OPEN = ["M14 4h6v6", "M20 4l-9 9", "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"]

    const remembered = () => {
      try {
        return localStorage.getItem(STORE) ?? ""
      } catch {
        return ""
      }
    }

    function FrameView() {
      const [input, setInput] = useState(remembered)
      const [url, setUrl] = useState(null)
      const [error, setError] = useState(null)
      const [stamp, setStamp] = useState(0)
      const frame = useRef(null)

      const go = (value) => {
        const out = previewUrl(value, window.location)
        if (out.error) {
          setError(out.error)
          return
        }
        setError(null)
        setUrl(out.url)
        setInput(out.url)
        setStamp((n) => n + 1)
        try {
          localStorage.setItem(STORE, out.url)
        } catch {
          // A remembered address is a convenience only
        }
      }

      useEffect(() => {
        const first = remembered()
        if (first && !previewUrl(first, window.location).error) go(first)
        // Only on first show
      }, [])

      return h(
        React.Fragment,
        null,
        h(
          "div",
          { className: "kh-pv-bar" },
          h(
            "form",
            {
              className: "kh-pv-form",
              onSubmit: (e) => {
                e.preventDefault()
                go(input)
              },
            },
            h("input", {
              className: "kh-pv-input",
              value: input,
              onChange: (e) => setInput(e.target.value),
              placeholder: "localhost:3000",
              "aria-label": "Local address to preview",
              spellCheck: false,
              autoCapitalize: "off",
              autoCorrect: "off",
            })
          ),
          h("button", { type: "button", className: "kh-pv-btn", onClick: () => url && setStamp((n) => n + 1), disabled: !url, "aria-label": "Reload the preview", title: "Reload" }, svg(RELOAD)),
          h("button", { type: "button", className: "kh-pv-btn", onClick: () => url && window.open(url, "_blank", "noopener,noreferrer"), disabled: !url, "aria-label": "Open in your browser", title: "Open in your browser" }, svg(OPEN))
        ),
        error && h("div", { className: "kh-pv-error", role: "alert" }, error),
        url
          ? h("iframe", {
              key: stamp,
              ref: frame,
              className: "kh-pv-frame",
              src: url,
              title: `Preview of ${url}`,
              referrerPolicy: "no-referrer",
              // The app's own origin (another port), never Kriya Harness's
              sandbox: "allow-scripts allow-forms allow-same-origin allow-popups allow-modals allow-downloads",
            })
          : h(
              "div",
              { className: "kh-pv-note" },
              "Preview an app running on this computer: type its local address (for example localhost:3000) and press Enter. If the page stays blank, the app refuses to be framed; open it in your browser with the arrow."
            )
      )
    }

    const API = { state: "api/kriya.browser.state", frame: "api/kriya.browser.frame", input: "api/kriya.browser.input" }
    const VIEW = { width: 1280, height: 800 }
    const FRAME_MS = 400

    async function send(body) {
      const response = await fetch(API.input, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || `Kriya answered ${response.status}.`)
      return data
    }

    // The agent's browser (stage 2): its live page as frames, and the
    // person's address, clicks, scrolls and keys sent to the same page
    function AgentView({ visible }) {
      const [src, setSrc] = useState(null)
      const [where, setWhere] = useState("")
      const [input, setInput] = useState("")
      const [error, setError] = useState(null)
      const img = useRef(null)

      useEffect(() => {
        if (!visible) return
        let alive = true
        let last
        const tick = async () => {
          try {
            const response = await fetch(API.frame, { credentials: "same-origin" })
            if (response.status === 204) {
              if (alive) setSrc(null)
            } else if (response.ok) {
              const url = URL.createObjectURL(await response.blob())
              if (!alive) return URL.revokeObjectURL(url)
              if (last) URL.revokeObjectURL(last)
              last = url
              setSrc(url)
              setWhere(decodeURI(response.headers.get("x-kriya-url") || ""))
            }
          } catch {
            // The next tick tries again
          }
        }
        tick()
        const timer = setInterval(tick, FRAME_MS)
        return () => {
          alive = false
          clearInterval(timer)
          if (last) URL.revokeObjectURL(last)
        }
      }, [visible])

      const act = (body) => send(body).then(() => setError(null), (e) => setError(e.message))
      const point = (e) => {
        const r = img.current.getBoundingClientRect()
        return { x: Math.round(((e.clientX - r.left) / r.width) * VIEW.width), y: Math.round(((e.clientY - r.top) / r.height) * VIEW.height) }
      }
      const KEYS = new Set(["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"])
      const onKey = (e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return
        if (KEYS.has(e.key)) {
          e.preventDefault()
          act({ kind: "key", key: e.key })
        } else if (e.key.length === 1) {
          e.preventDefault()
          act({ kind: "text", text: e.key })
        }
      }

      return h(
        React.Fragment,
        null,
        h(
          "div",
          { className: "kh-pv-bar" },
          h(
            "form",
            {
              className: "kh-pv-form",
              onSubmit: (e) => {
                e.preventDefault()
                const out = previewUrl(input, window.location)
                if (out.error) return setError(out.error)
                act({ kind: "open", url: out.url })
              },
            },
            h("input", { className: "kh-pv-input", value: input, onChange: (e) => setInput(e.target.value), placeholder: "localhost:3000", "aria-label": "Local address for the agent's browser", spellCheck: false, autoCapitalize: "off", autoCorrect: "off" })
          )
        ),
        error && h("div", { className: "kh-pv-error", role: "alert" }, error),
        where && h("div", { className: "kh-pv-url", title: where }, where),
        src
          ? h(
              "div",
              { className: "kh-pv-live" },
              h("img", {
                ref: img,
                className: "kh-pv-shot",
                src,
                alt: `The agent's browser: ${where}`,
                tabIndex: 0,
                onClick: (e) => (img.current.focus(), act({ kind: "click", ...point(e) })),
                onWheel: (e) => act({ kind: "wheel", ...point(e), deltaY: e.deltaY }),
                onKeyDown: onKey,
              })
            )
          : h("div", { className: "kh-pv-note" }, "The agent's browser has no page open yet. Type a local address above, or ask the agent to open your app; you'll see and can click the same page here.")
      )
    }

    function PreviewBody({ useTabInfo }) {
      const visible = useTabInfo?.().tab?.visible !== false
      const [agent, setAgent] = useState(false)
      const [mode, setMode] = useState("frame")
      useEffect(() => {
        let alive = true
        fetch(API.state, { credentials: "same-origin" })
          .then((r) => (r.ok ? r.json() : null))
          .then((s) => {
            if (!alive || !s?.enabled) return
            setAgent(true)
            if (s.url) setMode("agent")
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [])
      return h(
        "div",
        { className: "kh-pv" },
        agent &&
          h(
            "div",
            { className: "kh-pv-modes", role: "group", "aria-label": "What the preview shows" },
            h("button", { type: "button", className: "kh-pv-mode", "aria-pressed": mode === "frame", onClick: () => setMode("frame") }, "Your app"),
            h("button", { type: "button", className: "kh-pv-mode", "aria-pressed": mode === "agent", onClick: () => setMode("agent") }, "Agent's browser")
          ),
        mode === "agent" ? h(AgentView, { visible }) : h(FrameView)
      )
    }

    const definition = {
      id: PLUGIN,
      kind: KIND,
      priority: "extension",
      title: () => "Preview",
      guide: [{ id: "preview", order: 7, title: () => "Preview", description: () => "An app running on this computer (localhost)", icon: TabIcon }],
    }

    const inject = ["slots", "sidebarRightTabs"]

    function apply(ctx) {
      if (typeof document !== "undefined") ctx.effect(installStyles, "kriya-preview: styles")
      ctx.effect(() => ctx.sidebarRightTabs.register(definition), "kriya-preview: type")
      ctx.effect(
        () => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({ name: "sidebar.right.pane.tab", key: PLUGIN }, PreviewBody)),
        "kriya-preview: body"
      )
    }

    return { apply, inject, PreviewBody, definition, previewUrl }
  },
})
