// The Developer tab, browser half (Kriya-Tavi docs/kriya-harness/DEVELOPER_COCKPIT.md):
// a right-sidebar page beside Overview with the project's GitHub state, the
// person's connections (each provider's own CLI login), the servers running in
// this folder and the project's health. Every change is the person's click,
// confirmed first; it reads and acts only through this plugin's route (index.js).
window.__ModuleLoader__.load({
  id: "@kriya-ai/harness-cockpit",
  factory: (require) => {
    const React = require("react")
    const { useCallback, useEffect, useState } = React
    const h = React.createElement

    const PLUGIN = "@kriya-ai/harness-cockpit"
    const KIND = "kriya-cockpit"
    const API = "api/kriya.cockpit"
    const REFRESH_MS = 5000

    const CSS = `
.kh-dv { height: 100%; overflow: auto; color: var(--dsw-alias-label-primary); font-size: 13px; padding: 4px 0 16px; }
.kh-dv-sec { padding: 10px 14px 12px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.kh-dv-sec:last-child { border-bottom: 0; }
.kh-dv-h { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0 0 6px; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.kh-dv-row { display: flex; align-items: center; gap: 8px; min-height: 30px; }
.kh-dv-val { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kh-dv-mono { font-family: var(--dsw-font-code, ui-monospace, monospace); font-size: 12px; }
.kh-dv-dim { color: var(--dsw-alias-label-tertiary); }
.kh-dv-note { font-size: 12px; line-height: 1.45; color: var(--dsw-alias-label-tertiary); margin: 2px 0 6px; }
.kh-dv-warn { color: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-error-primary)); }
.kh-dv-err { color: var(--dsw-alias-state-error-primary); }
.kh-dv-ok { color: var(--dsw-alias-state-success-primary); }
.kh-dv-pill { flex: none; font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.kh-dv-pill.ok { color: var(--dsw-alias-state-success-primary); border-color: currentColor; }
.kh-dv-pill.bad { color: var(--dsw-alias-state-error-primary); border-color: currentColor; }
.kh-dv-pill.wait { color: var(--dsw-alias-link); border-color: currentColor; }
.kh-dv-btn { flex: none; min-height: 32px; padding: 0 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1, transparent); color: inherit; font: inherit; font-size: 12.5px; cursor: pointer; }
/* Accent text on a light tint of it: the theme's link colour already meets contrast on panels in light and dark */
.kh-dv-btn.primary { background: color-mix(in srgb, var(--dsw-alias-link) 12%, transparent); border-color: color-mix(in srgb, var(--dsw-alias-link) 55%, transparent); color: var(--dsw-alias-link); font-weight: 600; }
.kh-dv-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.kh-dv-btn.primary:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-link) 20%, transparent); }
.kh-dv-btn:disabled { opacity: .5; cursor: default; }
.kh-dv-btn:focus-visible, .kh-dv-input:focus-visible, .kh-dv-link:focus-visible { outline: 2px solid var(--dsw-alias-link); outline-offset: 2px; }
.kh-dv-icon { min-width: 44px; min-height: 44px; margin: -12px -10px -12px 0; border: 0; border-radius: 10px; background: transparent; color: inherit; cursor: pointer; display: grid; place-items: center; }
.kh-dv-icon:hover { background: var(--dsw-alias-interactive-bg-hover); }
.kh-dv-input { flex: 1; min-width: 0; min-height: 32px; padding: 0 10px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: inherit; font: inherit; font-size: 12.5px; }
.kh-dv-code { display: flex; align-items: center; gap: 8px; margin: 4px 0; padding: 6px 8px; border-radius: 10px; background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-border-l2)); }
.kh-dv-code > code { flex: 1; min-width: 0; overflow-x: auto; white-space: nowrap; font-family: var(--dsw-font-code, ui-monospace, monospace); font-size: 12px; }
.kh-dv-big { font-family: var(--dsw-font-code, ui-monospace, monospace); font-size: 20px; letter-spacing: .08em; font-weight: 600; }
.kh-dv-link { color: var(--dsw-alias-link); text-decoration: none; }
.kh-dv-link:hover { text-decoration: underline; }
.kh-dv-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 2px 0 6px; }
.kh-dv-switch { flex: none; width: 44px; height: 26px; padding: 3px; border: 0; border-radius: 999px; background: var(--dsw-alias-border-l2); cursor: pointer; position: relative; }
.kh-dv-switch::before { content: ""; position: absolute; inset: -9px 0; }
.kh-dv-switch > span { display: block; width: 20px; height: 20px; border-radius: 50%; background: #fff; transition: transform .15s; }
.kh-dv-switch.on { background: var(--dsw-alias-link); }
.kh-dv-switch.on > span { transform: translateX(18px); }
.kh-dv-switch:focus-visible { outline: 2px solid var(--dsw-alias-link); outline-offset: 2px; }
.kh-dv-wrap { white-space: normal; line-height: 1.4; padding: 4px 0; }
.kh-dv-sub { margin: 10px 0 4px; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.kh-dv-form { display: flex; flex-direction: column; gap: 6px; margin: 4px 0 8px; }
.kh-dv-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin-bottom: 6px; }
.kh-dv-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; font-size: 12px; }
select.kh-dv-input { padding-right: 6px; }
.kh-dv-confirm { position: sticky; top: 0; z-index: 2; margin: 0 10px 6px; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--dsw-alias-link); background: var(--dsw-alias-bg-layer-0, var(--dsw-alias-bg-primary, Canvas)); box-shadow: 0 4px 16px rgba(0,0,0,.12); }
.kh-dv-confirm p { margin: 0 0 8px; line-height: 1.45; }
.kh-dv-error { padding: 12px 14px; color: var(--dsw-alias-state-error-primary); }
.kh-dv-empty { padding: 14px; color: var(--dsw-alias-label-tertiary); line-height: 1.5; }
@media (pointer: coarse) { .kh-dv-btn, .kh-dv-input { min-height: 44px; } }
`

    function installStyles() {
      const tag = document.createElement("style")
      tag.dataset.plugin = PLUGIN
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    const icon = (paths, size = 16) =>
      h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, ...paths.map((d, i) => h("path", { key: i, d })))
    const ICON = {
      tab: ["M8 9l-4 3 4 3", "M16 9l4 3-4 3", "M13.5 5l-3 14"],
      refresh: ["M20 11a8 8 0 1 0-2.3 5.7", "M20 4v7h-7"],
      copy: ["M9 9h10v10H9z", "M5 15V5h10"],
    }

    const Section = (title, children, action) => h("section", { className: "kh-dv-sec", "aria-label": title }, h("h3", { className: "kh-dv-h" }, title, action), children)
    const Pill = (text, tone) => h("span", { className: `kh-dv-pill${tone ? ` ${tone}` : ""}` }, text)

    function Copy({ text, label }) {
      const [done, setDone] = useState(false)
      return h(
        "div",
        { className: "kh-dv-code" },
        h("code", null, text),
        h(
          "button",
          {
            type: "button",
            className: "kh-dv-icon",
            "aria-label": done ? "Copied" : label || `Copy ${text}`,
            title: done ? "Copied" : "Copy",
            onClick: () => navigator.clipboard?.writeText(text).then(() => (setDone(true), setTimeout(() => setDone(false), 1500))),
          },
          done ? h("span", { className: "kh-dv-ok", "aria-hidden": true }, "✓") : icon(ICON.copy)
        )
      )
    }

    function Switch({ label, checked, disabled, onChange }) {
      return h("button", { type: "button", role: "switch", "aria-checked": checked, "aria-label": label, disabled, className: `kh-dv-switch${checked ? " on" : ""}`, onClick: () => onChange(!checked) }, h("span", null))
    }

    // A saved switch: what the next start uses, and whether that differs from now
    function Saved({ label, what, state, busy, onChange }) {
      const on = state.saved ?? state.running
      return [
        h("div", { key: "s", className: "kh-dv-row" }, h("span", { className: "kh-dv-val" }, label), h(Switch, { label, checked: on, disabled: busy, onChange })),
        h("p", { key: "n", className: "kh-dv-note" }, on !== state.running ? `${what} Restart Kriya Harness to apply this.` : what),
      ]
    }

    function GitHub({ data, act, busy }) {
      const g = data.github
      const sign = data.signIn
      const [name, setName] = useState(() => data.folder.split(/[\\/]/).filter(Boolean).pop() || "")
      const rows = []
      const push = (key, node) => rows.push(h(React.Fragment, { key }, node))
      if (g.state === "unavailable") push("u", h("p", { className: "kh-dv-note kh-dv-err" }, g.note))
      else if (g.state === "not a repository") {
        push("n", h("div", { className: "kh-dv-row" }, h("span", { className: "kh-dv-val kh-dv-dim" }, "Not under version control"), h("button", { type: "button", className: "kh-dv-btn", disabled: busy, onClick: () => act({ action: "git.init" }, "Start a git repository in this folder (git init)?") }, "Start a git repository")))
      } else {
        push("b", h("div", { className: "kh-dv-row" }, h("span", { className: "kh-dv-val" }, "Branch ", h("span", { className: "kh-dv-mono" }, g.branch)), Pill(`${g.changed} changed`)))
        for (const r of g.remotes) push(`r${r}`, h("div", { className: "kh-dv-row" }, h("span", { className: "kh-dv-val kh-dv-mono", title: r }, r)))
        if (g.state === "no remote") {
          push("nr", h("p", { className: "kh-dv-note" }, "Not on GitHub yet. Create a private repository and connect this folder to it (nothing is pushed until you or the agent push)."))
          push(
            "c",
            h(
              "div",
              { className: "kh-dv-row" },
              h("input", { className: "kh-dv-input", value: name, onChange: (e) => setName(e.target.value), "aria-label": "Repository name", placeholder: "repository-name", maxLength: 100 }),
              h("button", { type: "button", className: "kh-dv-btn primary", disabled: busy || !name.trim(), onClick: () => act({ action: "github.create", name: name.trim() }, `Create the private GitHub repository "${name.trim()}" and set it as origin?`) }, "Create on GitHub")
            )
          )
        }
        if (g.state === "remote, gh not installed") push("ni", [h("p", { key: "p", className: "kh-dv-note" }, "Install the GitHub CLI to see pull requests and checks:"), h(Copy, { key: "c", text: "brew install gh" })])
        if (g.state === "remote, gh signed out" || (g.state === "no remote" && !data.connections.find((c) => c.id === "github")?.signedIn)) {
          if (sign.status === "waiting")
            push(
              "w",
              h(
                "div",
                { role: "status" },
                h("p", { className: "kh-dv-note" }, "Enter this code on the GitHub page that opened in your browser:"),
                h("div", { className: "kh-dv-row" }, h("span", { className: "kh-dv-big" }, sign.code), h("button", { type: "button", className: "kh-dv-btn", onClick: () => act({ action: "github.signin.cancel" }) }, "Cancel"))
              )
            )
          else
            push(
              "s",
              h(
                "div",
                { className: "kh-dv-row" },
                h("span", { className: "kh-dv-val kh-dv-dim" }, sign.status === "failed" ? h("span", { className: "kh-dv-err" }, sign.error) : "Sign in to GitHub to create repositories and see pull requests."),
                h("button", { type: "button", className: "kh-dv-btn primary", disabled: busy || sign.status === "starting", onClick: () => act({ action: "github.signin" }) }, "Sign in to GitHub")
              )
            )
        }
        if (g.state === "remote, signed in") {
          push(
            "pr",
            g.pr
              ? h(
                  "div",
                  { className: "kh-dv-row" },
                  h("span", { className: "kh-dv-val", title: g.pr.title }, g.pr.url ? h("a", { className: "kh-dv-link", href: g.pr.url, target: "_blank", rel: "noreferrer" }, `#${g.pr.number}`) : `#${g.pr.number}`, " ", g.pr.title),
                  Pill(g.pr.draft ? "Draft" : String(g.pr.state).toLowerCase(), g.pr.state === "OPEN" ? "wait" : "")
                )
              : h("div", { className: "kh-dv-row kh-dv-dim" }, "No pull request for this branch.")
          )
          if (g.checks?.total)
            push(
              "ck",
              h(
                "div",
                { className: "kh-dv-chips", "aria-label": "Pull request checks" },
                g.checks.passed ? Pill(`✓ ${g.checks.passed} passed`, "ok") : null,
                g.checks.failed ? Pill(`✗ ${g.checks.failed} failed`, "bad") : null,
                g.checks.pending ? Pill(`${g.checks.pending} running`, "wait") : null
              )
            )
        }
        if (g.exposed?.length) push("ex", h("p", { className: "kh-dv-note kh-dv-warn", role: "alert" }, `Committed secret files: ${g.exposed.join(", ")}. Remove them from git (git rm --cached <file>) and rotate those keys.`))
      }
      push("t", Saved({ label: "Repository tools", what: "The agent may branch, commit, push and open draft pull requests, asking you each time.", state: data.switches.repoTools, busy, onChange: (on) => act({ action: "switch", flag: "repo-tools", on }) }))
      return Section("GitHub", rows)
    }

    function Connections({ data, act, busy, refresh }) {
      const rows = data.connections.map((c) => {
        const status = !c.installed ? Pill("Not installed") : c.signedIn ? Pill(c.account ? `Signed in · ${c.account}` : "Signed in", "ok") : Pill("Not signed in")
        return h(
          "div",
          { key: c.id },
          h("div", { className: "kh-dv-row" }, h("span", { className: "kh-dv-val" }, c.name, c.version && h("span", { className: "kh-dv-dim" }, ` · ${c.version}`)), status),
          !c.installed
            ? [h("p", { key: "p", className: "kh-dv-note" }, "Install its CLI, then refresh:"), h(Copy, { key: "c", text: c.install })]
            : !c.signedIn && c.id !== "github"
              ? [h("p", { key: "p", className: "kh-dv-note" }, "Sign in with its own CLI in a terminal (your browser opens); Kriya never sees the token:"), h(Copy, { key: "c", text: c.login })]
              : !c.signedIn
                ? h("p", { className: "kh-dv-note" }, "Sign in from the GitHub section above.")
                : null
        )
      })
      return Section(
        "Connections",
        [
          data.connectionsError && h("p", { key: "e", className: "kh-dv-note kh-dv-err", role: "alert" }, data.connectionsError),
          ...rows,
          h(React.Fragment, { key: "pt" }, Saved({ label: "Supabase and Render tools", what: "The agent may read projects, services, deploys, logs and migrations; anything that changes something asks you first.", state: data.switches.providerTools, busy, onChange: (on) => act({ action: "switch", flag: "provider-tools", on }) })),
        ],
        h("button", { type: "button", className: "kh-dv-icon", onClick: refresh, "aria-label": "Check connections again", title: "Check again" }, icon(ICON.refresh))
      )
    }

    function Servers({ data, act, busy }) {
      const s = data.servers
      if (s.error) return Section("Running servers", h("p", { className: "kh-dv-note kh-dv-err", role: "alert" }, s.error))
      if (!s.available) return Section("Running servers", h("p", { className: "kh-dv-note" }, "Listing servers needs lsof on this computer."))
      if (!s.list.length) return Section("Running servers", h("div", { className: "kh-dv-row kh-dv-dim" }, "No server is running in this folder."))
      return Section(
        "Running servers",
        s.list.map((p) =>
          h(
            "div",
            { key: p.pid, className: "kh-dv-row" },
            h(
              "span",
              { className: "kh-dv-val" },
              h("span", { className: "kh-dv-mono" }, p.command),
              " ",
              ...p.ports.map((port) => h("a", { key: port, className: "kh-dv-link kh-dv-mono", href: `http://localhost:${port}`, target: "_blank", rel: "noreferrer", style: { marginRight: 6 } }, `:${port}`)),
              p.folder !== "." && h("span", { className: "kh-dv-dim" }, ` · ${p.folder}`)
            ),
            h("button", { type: "button", className: "kh-dv-btn", disabled: busy, "aria-label": `Stop ${p.command} (process ${p.pid})`, onClick: () => act({ action: "server.stop", pid: p.pid }, `Stop ${p.command} on port ${p.ports.join(", ")} (process ${p.pid})?`) }, "Stop")
          )
        )
      )
    }

    function Health({ data, act, busy }) {
      const x = data.health
      if (x.error) return Section("Project health", h("p", { className: "kh-dv-note kh-dv-err", role: "alert" }, x.error))
      return Section("Project health", [
        x.stack.length ? h("div", { key: "s", className: "kh-dv-chips" }, ...x.stack.map((s) => h(React.Fragment, { key: s.id }, Pill(s.label)))) : h("div", { key: "s", className: "kh-dv-row kh-dv-dim" }, "No known project files here."),
        x.scripts.length ? h("div", { key: "sc", className: "kh-dv-row" }, h("span", { className: "kh-dv-val" }, "Scripts ", h("span", { className: "kh-dv-mono kh-dv-dim" }, x.scripts.join(" · ")))) : null,
        h(
          "div",
          { key: "c", className: "kh-dv-row" },
          h("span", { className: "kh-dv-val" }, "Check ", x.check ? h("span", { className: "kh-dv-mono" }, x.check) : h("span", { className: "kh-dv-dim" }, "none confirmed yet")),
          x.check ? Pill("confirmed", "ok") : null
        ),
        !x.check && h("p", { key: "cn", className: "kh-dv-note" }, "Confirm how this project is checked so Kriya can verify the agent's work:"),
        !x.check && h(Copy, { key: "cc", text: "kriya verify" }),
        !x.git && h("p", { key: "g", className: "kh-dv-note" }, "Not a git repository, so secret files can't be checked against .gitignore."),
        x.tracked.length > 0 && h("p", { key: "t", className: "kh-dv-note kh-dv-warn", role: "alert" }, `Committed secret files: ${x.tracked.join(", ")}. Remove them from git (git rm --cached <file>) and rotate those keys.`),
        x.unignored.length > 0 &&
          h(
            "div",
            { key: "u" },
            h("p", { className: "kh-dv-note kh-dv-warn" }, `Not ignored yet, so a commit could include them: ${x.unignored.join(", ")}.`),
            h("button", { type: "button", className: "kh-dv-btn", disabled: busy, onClick: () => act({ action: "health.ignore", files: x.unignored }, `Add ${x.unignored.join(", ")} to .gitignore?`) }, "Add to .gitignore")
          ),
        x.git && !x.tracked.length && !x.unignored.length && h("div", { key: "ok", className: "kh-dv-row kh-dv-ok" }, "No secret files exposed to git."),
      ])
    }

    // Your models (Kriya-Tavi docs/kriya-harness/OWN_MODELS.md): the person's own API keys and
    // their own orchestration. A key is typed here once, saved on this computer only, and never
    // shown again (its last four characters only)
    function OwnModels({ own, run, busy, changed }) {
      const [keyFor, setKeyFor] = useState(null)
      const [key, setKey] = useState("")
      const [url, setUrl] = useState("")
      const [provider, setProvider] = useState(() => own.providers.find((p) => p.saved)?.id ?? "")
      const [list, setList] = useState(null)
      const [model, setModel] = useState("")
      const [head, setHead] = useState(own.orchestra?.head ?? "")
      const [worker, setWorker] = useState(own.orchestra?.worker ?? "")
      const saved = own.providers.filter((p) => p.saved)
      useEffect(() => {
        if (!saved.some((p) => p.id === provider)) setProvider(saved[0]?.id ?? "")
      }, [own])
      const name = (id) => own.choices.find((c) => c.id === id)?.name ?? id
      const saveKey = async () => {
        const answer = await run({ action: "own.key.save", provider: keyFor, key, ...(keyFor === "custom" && { url }) })
        setKey("")
        if (answer) setKeyFor(null)
      }
      const load = async () => {
        setList(null)
        const answer = await run({ action: "own.models.list", provider })
        if (answer) setList(answer.models)
      }
      const picked = list?.find((m) => m.id === model)
      const rows = []
      const push = (k, node) => rows.push(h(React.Fragment, { key: k }, node))
      push("i", h("p", { className: "kh-dv-note" }, "Use your own API keys. Calls go straight from this computer to the provider; Kriya never sees your key, and counts only calls and tokens, never content."))
      for (const p of own.providers)
        push(
          `p-${p.id}`,
          h(
            "div",
            null,
            h(
              "div",
              { className: "kh-dv-row" },
              h("span", { className: "kh-dv-val" }, p.name, p.saved && p.url && h("span", { className: "kh-dv-dim kh-dv-mono" }, ` · ${p.url}`)),
              p.saved ? Pill(`Key ••••${p.last4}`, "ok") : null,
              h("button", { type: "button", className: "kh-dv-btn", disabled: busy, "aria-expanded": keyFor === p.id, onClick: () => (setKeyFor(keyFor === p.id ? null : p.id), setKey(""), setUrl(p.url ?? "")) }, p.saved ? "Replace" : "Add key"),
              p.saved && h("button", { type: "button", className: "kh-dv-btn", disabled: busy, "aria-label": `Remove the ${p.name} key`, onClick: () => run({ action: "own.key.remove", provider: p.id }) }, "Remove")
            ),
            keyFor === p.id &&
              h(
                "form",
                { className: "kh-dv-form", onSubmit: (e) => (e.preventDefault(), saveKey()) },
                p.id === "custom" && h("input", { className: "kh-dv-input", value: url, onChange: (e) => setUrl(e.target.value), placeholder: "https://api.example.com/v1", "aria-label": "Custom provider address", inputMode: "url", autoComplete: "off", spellCheck: false }),
                h(
                  "div",
                  { className: "kh-dv-row" },
                  h("input", { className: "kh-dv-input", type: "password", value: key, onChange: (e) => setKey(e.target.value), placeholder: `${p.name} API key`, "aria-label": `${p.name} API key`, autoComplete: "off", spellCheck: false, autoFocus: true }),
                  h("button", { type: "submit", className: "kh-dv-btn primary", disabled: busy || key.trim().length < 8 }, "Save")
                ),
                p.keysUrl && h("p", { className: "kh-dv-note" }, "Get a key at ", h("a", { className: "kh-dv-link", href: p.keysUrl, target: "_blank", rel: "noreferrer" }, new URL(p.keysUrl).host), ". It's saved on this computer only.")
              )
          )
        )
      if (saved.length) {
        push("mh", h("h4", { className: "kh-dv-sub" }, "Models"))
        for (const m of own.models)
          push(`m-${m.id}`, h("div", { className: "kh-dv-row" }, h("span", { className: "kh-dv-val", title: m.name }, m.name, h("span", { className: "kh-dv-dim" }, ` · ${Math.round(m.contextWindow / 1000)}k`)), h("button", { type: "button", className: "kh-dv-btn", disabled: busy, "aria-label": `Remove ${m.name}`, onClick: () => run({ action: "own.model.remove", id: m.id }) }, "Remove")))
        if (!own.models.length) push("mn", h("div", { className: "kh-dv-row kh-dv-dim" }, "No model added yet."))
        push(
          "ma",
          h(
            "div",
            { className: "kh-dv-row" },
            h("select", { className: "kh-dv-input", value: provider, onChange: (e) => (setProvider(e.target.value), setList(null), setModel("")), "aria-label": "Provider" }, ...saved.map((p) => h("option", { key: p.id, value: p.id }, p.name))),
            h("button", { type: "button", className: "kh-dv-btn", disabled: busy || !provider, onClick: load }, "Load models")
          )
        )
        if (list)
          push(
            "ml",
            h(
              "form",
              { className: "kh-dv-row", onSubmit: (e) => (e.preventDefault(), run({ action: "own.model.add", provider, model, ...(picked?.contextWindow && { contextWindow: picked.contextWindow }) }).then((a) => a && setModel(""))) },
              h("input", { className: "kh-dv-input kh-dv-mono", list: "kh-dv-models", value: model, onChange: (e) => setModel(e.target.value), placeholder: `Search ${list.length} models`, "aria-label": "Model", autoComplete: "off", spellCheck: false }),
              h("datalist", { id: "kh-dv-models" }, ...list.slice(0, 1000).map((m) => h("option", { key: m.id, value: m.id }))),
              h("button", { type: "submit", className: "kh-dv-btn primary", disabled: busy || !list.some((m) => m.id === model) }, "Add")
            )
          )
      }
      const options = (role) => [h("option", { key: "", value: "" }, role === "head" ? "Choose the head…" : "Choose the worker…"), ...own.choices.filter((c) => role === "worker" || c.id !== "local").map((c) => h("option", { key: c.id, value: c.id }, c.name))]
      push("oh", h("h4", { className: "kh-dv-sub" }, "Your orchestration"))
      push("on", h("p", { className: "kh-dv-note" }, "The head plans, reviews and takes over when the worker is stuck; the worker builds each step. Mix your models, Kriya's and a local one."))
      push(
        "os",
        h(
          "div",
          { className: "kh-dv-grid" },
          h("label", { className: "kh-dv-field" }, h("span", { className: "kh-dv-dim" }, "Head"), h("select", { className: "kh-dv-input", value: head, "aria-label": "Head model", onChange: (e) => setHead(e.target.value) }, ...options("head"))),
          h("label", { className: "kh-dv-field" }, h("span", { className: "kh-dv-dim" }, "Worker"), h("select", { className: "kh-dv-input", value: worker, "aria-label": "Worker model", onChange: (e) => setWorker(e.target.value) }, ...options("worker")))
        )
      )
      push(
        "ob",
        h(
          "div",
          { className: "kh-dv-row" },
          h("span", { className: "kh-dv-val kh-dv-dim kh-dv-wrap" }, own.orchestra ? `Saved: ${name(own.orchestra.head)} leads, ${name(own.orchestra.worker)} builds.` : "Not set: Kriya's orchestration is used."),
          own.orchestra && h("button", { type: "button", className: "kh-dv-btn", disabled: busy, onClick: () => run({ action: "own.orchestra", orchestra: null }).then(() => (setHead(""), setWorker(""))) }, "Clear"),
          h("button", { type: "button", className: "kh-dv-btn primary", disabled: busy || !head || !worker || head === worker || (own.orchestra?.head === head && own.orchestra?.worker === worker), onClick: () => run({ action: "own.orchestra", orchestra: { head, worker } }) }, "Save")
        )
      )
      if (head && head === worker) push("ow", h("p", { className: "kh-dv-note kh-dv-warn" }, "Choose two different models."))
      if (changed) push("rs", h("p", { className: "kh-dv-note", role: "status" }, "Saved. Restart Kriya Harness to use these changes."))
      return Section("Your models", rows)
    }

    function DeveloperBody({ useTabInfo, sessionId }) {
      const { tab } = useTabInfo()
      const visible = tab?.visible !== false
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [done, setDone] = useState(null)
      // An action waiting for the person's Confirm, shown in the tab (no native dialog)
      const [pending, setPending] = useState(null)

      const load = useCallback(
        async (fresh) => {
          if (!sessionId) return
          try {
            const q = new URLSearchParams({ session: sessionId, ...(fresh && { fresh: "1" }) })
            const response = await fetch(`${API}?${q}`, { credentials: "same-origin" })
            const body = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(body.error || `Kriya Harness answered ${response.status}.`)
            setData(body)
            setError(null)
          } catch (e) {
            setError(e.message === "Failed to fetch" ? "Kriya Harness isn't answering; is it still running?" : e.message)
          }
        },
        [sessionId]
      )
      useEffect(() => {
        if (!visible) return
        load()
        const timer = setInterval(() => load(), REFRESH_MS)
        return () => clearInterval(timer)
      }, [visible, load])

      const act = (body, confirmText) => (confirmText ? setPending({ body, text: confirmText }) : run(body))
      const run = async (body) => {
        setPending(null)
        setBusy(true)
        setDone(null)
        try {
          const response = await fetch(API, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: sessionId, ...body }) })
          const answer = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(answer.error || `Kriya Harness answered ${response.status}.`)
          if (answer.url) setDone(answer.url)
          setError(null)
          if (body.action.startsWith("own.")) setChanged(body.action !== "own.models.list")
          await load(body.action === "github.create" || body.action === "switch")
          setBusy(false)
          return answer
        } catch (e) {
          setError(e.message)
        }
        setBusy(false)
        return null
      }
      // Own models: saved changes apply at the next start, which the section says
      const [changed, setChangedState] = useState(false)
      const setChanged = (v) => v && setChangedState(true)

      if (!sessionId) return h("div", { className: "kh-dv-empty" }, "Start or open a session to see this folder's GitHub, connections, servers and health.")
      if (error && !data) return h("div", { className: "kh-dv-error", role: "alert" }, error)
      if (!data) return h("div", { className: "kh-dv-empty" }, "Loading…")
      return h(
        "div",
        { className: "kh-dv" },
        error && h("div", { className: "kh-dv-error", role: "alert" }, error),
        pending &&
          h(
            "div",
            { className: "kh-dv-confirm", role: "alertdialog", "aria-label": "Confirm", "aria-describedby": "kh-dv-confirm-text" },
            h("p", { id: "kh-dv-confirm-text" }, pending.text),
            h(
              "div",
              { className: "kh-dv-row" },
              h("button", { type: "button", className: "kh-dv-btn primary", autoFocus: true, onClick: () => run(pending.body) }, "Confirm"),
              h("button", { type: "button", className: "kh-dv-btn", onClick: () => setPending(null) }, "Cancel")
            )
          ),
        done && h("div", { className: "kh-dv-empty", role: "status" }, "Created: ", h("a", { className: "kh-dv-link", href: done, target: "_blank", rel: "noreferrer" }, done)),
        h(GitHub, { key: "g", data, act, busy }),
        data.own && h(OwnModels, { key: "o", own: data.own, run, busy, changed }),
        data.ownError && Section("Your models", h("p", { className: "kh-dv-note kh-dv-err", role: "alert" }, data.ownError)),
        h(Connections, { key: "c", data, act, busy, refresh: () => load(true) }),
        h(Servers, { key: "s", data, act, busy }),
        h(Health, { key: "h", data, act, busy })
      )
    }

    const definition = {
      id: PLUGIN,
      kind: KIND,
      priority: "extension",
      title: () => "Developer",
      guide: [{ id: "developer", order: 6, title: () => "Developer", description: () => "GitHub, connections, running servers and project health", icon: () => icon(ICON.tab, 20) }],
    }

    const inject = ["slots", "sidebarRightTabs"]

    function apply(ctx) {
      if (typeof document !== "undefined") ctx.effect(installStyles, "kriya-cockpit: styles")
      ctx.effect(() => ctx.sidebarRightTabs.register(definition), "kriya-cockpit: type")
      ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({ name: "sidebar.right.pane.tab", key: PLUGIN }, DeveloperBody)), "kriya-cockpit: body")
    }

    return { apply, inject, DeveloperBody, definition, API }
  },
})
