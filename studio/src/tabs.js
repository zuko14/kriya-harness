// Tabs (redesign 2026-11-12): one strip of buttons and one visible panel, used by the Kriya panel (Brief, Chat,
// Activity) and by the Plan Card's sections. ARIA tabs with roving focus: arrows, Home and End move between
// them, Enter or a click shows one. A badge on a tab says something new is there.

import { h } from "./dom.js"

let made = 0

/**
 * @param {{ key: string, label: string, panel: HTMLElement, count?: () => number | null }[]} items
 * @param {{ label: string, selected?: string, onSelect?: (key: string) => void, className?: string }} options
 * @returns {{ strip: HTMLElement, select: (key: string, opts?: { focus?: boolean }) => void, selected: () => string, mark: (key: string, value: number | string | null) => void, refresh: () => void }}
 */
export function createTabs(items, { label, selected = items[0]?.key, onSelect = () => {}, className = "" } = {}) {
  const id = `tabs-${++made}`
  let current = null
  const buttons = new Map()
  const badges = new Map()
  const counts = new Map()
  for (const item of items) {
    const count = h("span", { class: "tab-count" })
    const badge = h("span", { class: "tab-badge", hidden: true })
    counts.set(item.key, count)
    badges.set(item.key, badge)
    const button = h("button", { type: "button", role: "tab", id: `${id}-${item.key}`, class: "tab", "aria-controls": `${id}-${item.key}-panel`, "aria-selected": "false", tabindex: "-1", onclick: () => select(item.key, { focus: true }) }, h("span", { class: "tab-label" }, item.label), count, badge)
    buttons.set(item.key, button)
    Object.assign(item.panel, { id: `${id}-${item.key}-panel` })
    item.panel.setAttribute("role", "tabpanel")
    item.panel.setAttribute("aria-labelledby", button.id)
    item.panel.classList.add("tab-panel")
  }
  const keys = items.map((i) => i.key)
  const strip = h(
    "div",
    {
      class: `tabs ${className}`.trim(),
      role: "tablist",
      "aria-label": label,
      onkeydown: (event) => {
        const at = keys.indexOf(current)
        const next = { ArrowRight: at + 1, ArrowDown: at + 1, ArrowLeft: at - 1, ArrowUp: at - 1, Home: 0, End: keys.length - 1 }[event.key]
        if (next === undefined) return
        event.preventDefault()
        event.stopPropagation()
        select(keys[(next + keys.length) % keys.length], { focus: true })
      },
    },
    ...buttons.values(),
  )
  function refresh() {
    for (const item of items) {
      const n = item.count?.()
      counts.get(item.key).textContent = n === null || n === undefined ? "" : String(n)
    }
  }
  function mark(key, value) {
    const badge = badges.get(key)
    if (!badge) return
    badge.hidden = value === null || value === 0 || value === "" || key === current
    badge.textContent = badge.hidden ? "" : String(value)
    badge.setAttribute("aria-label", badge.hidden ? "" : `${value} new`)
  }
  function select(key, { focus = false } = {}) {
    if (!buttons.has(key)) return
    current = key
    for (const item of items) {
      const on = item.key === key
      const button = buttons.get(item.key)
      button.setAttribute("aria-selected", String(on))
      button.tabIndex = on ? 0 : -1
      item.panel.hidden = !on
    }
    mark(key, null)
    if (focus) buttons.get(key).focus()
    onSelect(key)
  }
  refresh()
  select(selected)
  return { strip, select, selected: () => current, mark, refresh }
}
