// The Variations wall (TP8, CRAFT_UPGRADE §6.5), only with editing.directorLoop on: three short drafts
// of the opening, each on a different line, side by side. One press picks one, and the next make opens
// on that line. The words shown are the speaker's own, from the transcript: data, drawn as text only.

import { h } from "./dom.js"

/**
 * @param {{ project: string, state: { status: "none" | "making" | "ready" | "failed", progress?: number, job?: string, openings?: { n: number, hook: string, words: string, seconds: number }[], error?: string }, chosen: string | null, onAsk: () => void, onChoose: (hook: string | null) => void }} wall
 * @returns {HTMLElement}
 */
export function variationsWall({ project, state, chosen, onAsk, onChoose }) {
  const ask = h("button", { type: "button", class: "btn wide", id: "openings-ask", disabled: state.status === "making", onclick: onAsk }, state.status === "ready" ? "Three more openings" : "Give me three openings")
  if (state.status === "making") return h("div", { class: "openings", "aria-live": "polite" }, ask, h("p", { class: "note small" }, `Drafting three openings… ${state.progress ?? 0}%`), h("progress", { max: 100, value: state.progress ?? 0, "aria-label": "Drafting three openings" }))
  if (state.status !== "ready") return h("div", { class: "openings" }, ask, h("p", { class: "note small" }, state.status === "failed" ? `Couldn't draft them: ${state.error ?? "the drafts stopped"}` : "Three quick eight-second drafts, each starting on a different line. Pick one and the next make opens on it."))
  const number = String(state.job ?? "").split(".").at(-1)
  const cards = state.openings.map((o) => {
    const on = chosen === o.hook
    return h(
      "li",
      { class: `opening${on ? " chosen" : ""}` },
      h("video", { class: "opening-film", src: `/projects/${encodeURIComponent(project)}/openings/${encodeURIComponent(number)}/${o.n}`, controls: true, preload: "metadata", playsinline: true, "aria-label": `Opening ${o.n + 1}` }),
      h("p", { class: "opening-words" }, h("span", { class: "opening-tag" }, `${o.n + 1} · ${o.seconds} s`), " ", `“${o.words}”`),
      h("button", { type: "button", class: `btn${on ? " primary" : ""}`, id: `opening-use-${o.n}`, "aria-pressed": on ? "true" : "false", onclick: () => onChoose(on ? null : o.hook) }, on ? "Chosen ✓" : "Open on this"),
    )
  })
  return h("div", { class: "openings" }, h("h3", { class: "openings-head" }, "Openings"), h("ul", { class: "openings-wall", id: "openings-wall" }, cards), h("p", { class: "note small" }, chosen ? "The next make opens on the line you picked." : "Pick one, or keep the Director's choice."), ask)
}
