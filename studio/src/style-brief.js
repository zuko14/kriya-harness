// The style brief's card (TP6, CRAFT_UPGRADE §4.2), only with editing.referenceIntent on: "From
// this reference", one row per trait Kriya read, marked matched, nearest or can't, with the reason
// and any gate that outranks the reference. The person unticks a row and the next cut leaves it
// out. Every sentence comes from the Host, written by code over measured numbers: nothing here is
// the reference's own text, and nothing is shown that wasn't measured.

import { h } from "./dom.js"

const MARK = { matched: ["✓", "matched"], nearest: ["≈", "nearest"], cannot: ["✗", "can't"] }

/**
 * @param {{ id: string, where: string, state: { status: "none" | "measuring" | "ready" | "failed", progress?: number, brief?: object, error?: string }, off: Set<string>, onRead: () => void, onCancel: () => void, onToggle: (trait: string, on: boolean) => void }} card
 * @returns {HTMLElement}
 */
export function styleBriefCard({ id, where, state, off, onRead, onCancel, onToggle }) {
  const key = `${where}-${id}`
  if (state.status === "measuring") {
    const progress = state.progress ?? 0
    return h("div", { class: "style-brief", "aria-live": "polite" }, h("p", { class: "note small" }, `Reading its style… ${progress}%`), h("progress", { max: 100, value: progress, "aria-label": "Reading the reference's style" }), h("button", { type: "button", class: "btn", id: `style-cancel-${key}`, onclick: onCancel }, "Cancel"))
  }
  if (state.status !== "ready")
    return h(
      "div",
      { class: "style-brief" },
      h("button", { type: "button", class: "btn", id: `style-read-${key}`, onclick: onRead }, "Read its style"),
      h("p", { class: "note small" }, state.status === "failed" ? `Couldn't read it: ${state.error ?? "the measure stopped"}` : "Measured on this computer, as numbers only: its cuts, transitions, captions, colour and sound. No picture, sound or words from it are kept."),
    )
  const { lines, unread } = state.brief
  const rows = lines.map((line) => {
    const [mark, word] = MARK[line.state] ?? MARK.cannot
    const box = `style-${key}-${line.id}`
    // A row that changes the cut can be unticked; one the gates decide, or one Kriya can't do, is only said
    const tick = line.set && !line.locked ? h("input", { type: "checkbox", id: box, checked: !off.has(line.id), onchange: (event) => onToggle(line.id, event.target.checked) }) : h("span", { class: "style-fixed", "aria-hidden": "true" })
    const text = h("span", { class: "style-text" }, h("span", { class: `style-mark ${line.state}`, "aria-hidden": "true" }, mark), h("span", { class: "sr-only" }, `${word}: `), line.text, line.gate ? h("span", { class: "chip style-gate", title: "A quality gate outranks the reference here" }, `gate: ${line.gate}`) : null)
    const why = line.why ? h("span", { class: "style-why" }, line.why) : null
    return h("li", { class: `style-row ${line.state}` }, line.set && !line.locked ? h("label", { class: "style-label", for: box }, tick, h("span", { class: "style-body" }, text, why)) : h("div", { class: "style-label" }, tick, h("span", { class: "style-body" }, text, why)))
  })
  return h(
    "div",
    { class: "style-brief" },
    h("h3", { class: "style-head" }, "From this reference"),
    h("ul", { class: "style-rows", id: `style-rows-${key}` }, rows),
    unread.length ? h("p", { class: "note small style-unread" }, `Couldn't read: ${unread.join(", ")}.`) : null,
    h("button", { type: "button", class: "btn", id: `style-read-${key}`, onclick: onRead }, "Read it again"),
  )
}
