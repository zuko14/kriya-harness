// Delete session, browser half: one row in a session's "..." menu after
// Archive, asking first in a native <dialog>. The row leaves the list when
// the Host's session list changes. No DSH file is edited (HD-02).
window.__ModuleLoader__.load({
  id: "@kriya-ai/harness-sessions",
  factory: (require) => {
    const React = require("react")
    const { MenuItemButton } = require("@deepseek-ai/dsh-client-ui-primitives")
    const h = React.createElement

    const API = "api/kriya.session.delete"

    function ask(title) {
      return new Promise((done) => {
        const dialog = document.createElement("dialog")
        dialog.style.cssText = "max-width:360px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;padding:18px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary)"
        const heading = document.createElement("h2")
        heading.style.cssText = "margin:0 0 6px;font-size:15px"
        heading.textContent = `Delete ${title ? `"${title}"` : "this session"}?`
        const text = document.createElement("p")
        text.style.cssText = "margin:0 0 14px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary)"
        text.textContent = "Its conversation and history are removed from this computer, and any work in it stops. This can't be undone. Files in the folder stay."
        const row = document.createElement("div")
        row.style.cssText = "display:flex;gap:8px;justify-content:flex-end"
        const button = (label, value, danger) => {
          const b = document.createElement("button")
          b.type = "button"
          b.textContent = label
          b.style.cssText = `min-height:44px;padding:0 14px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);cursor:pointer;background:${danger ? "var(--dsw-alias-state-error-primary)" : "transparent"};color:${danger ? "#fff" : "inherit"}`
          b.onclick = () => dialog.close(value)
          return b
        }
        const cancel = button("Cancel", "", false)
        row.append(cancel, button("Delete", "yes", true))
        dialog.append(heading, text, row)
        dialog.addEventListener("close", () => {
          done(dialog.returnValue === "yes")
          dialog.remove()
        })
        document.body.append(dialog)
        dialog.showModal()
        cancel.focus()
      })
    }

    async function remove(sessionId, title) {
      if (!(await ask(title))) return
      const response = await fetch(API, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: sessionId }) })
      if (!response.ok) return window.alert((await response.json().catch(() => ({}))).error || "Kriya Harness couldn't delete this session.")
      // DSH's list has no "gone" event, only archive: a fresh read drops the row
      window.location.reload()
    }

    function DeleteRow({ sessionId, displayTitle, useMenuOpenState }) {
      const [, setMenuOpen] = useMenuOpenState()
      return h(MenuItemButton, { separatorBefore: true, onSelect: () => { setMenuOpen(false); remove(sessionId, displayTitle) } }, "Delete session")
    }

    const inject = ["slots"]
    function apply(ctx) {
      ctx.slots.inject("sidebar.workspaces.session.menu.item", () =>
        // After Copy Session ID (450): the one action that can't be undone goes last
        ctx.slots.register({ name: "sidebar.workspaces.session.menu.item", id: "kriya.delete-session", order: 500 }, DeleteRow)
      )
    }
    return { apply, inject, DeleteRow, API }
  },
})
