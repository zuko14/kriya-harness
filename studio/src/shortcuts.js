// The keyboard shortcuts sheet (editing.livePreview): every key the Studio answers, listed from the
// same key map the keyboard uses (time.js keyAction), so the sheet can't promise a key that does
// nothing. tests/edit-live-studio.test.js runs each row through keyAction.

import { h } from "./dom.js"

/** Each row: the keys as a person presses them, what keyAction must answer for them, and what it does. */
export const SHORTCUTS = [
  { group: "Play", keys: ["Space"], press: [" "], action: "toggle", does: "Play or pause" },
  { group: "Play", keys: ["J", "K", "L"], press: ["j", "k", "l"], action: ["reverse", "rate", "faster"], does: "Play backwards, stop, play forwards (press again to go faster)" },
  { group: "Play", keys: ["←", "→"], press: ["ArrowLeft", "ArrowRight"], action: "step", does: "One frame back or forward" },
  { group: "Play", keys: ["Shift", "←/→"], press: ["ArrowLeft"], shift: true, action: "step", does: "One second back or forward" },
  { group: "Play", keys: ["Home"], press: ["Home"], action: "seek", does: "To the start" },
  { group: "Cut", keys: ["I", "O"], press: ["i", "o"], action: "mark", does: "Mark in and out: the marked stretch is \"this\" to Kriya" },
  { group: "Cut", keys: ["S"], press: ["s"], action: "split", does: "Split the clip at the playhead" },
  { group: "Cut", keys: ["Delete"], press: ["Delete", "Backspace"], action: "delete", does: "Remove the selected clip and close the gap" },
  { group: "Cut", keys: ["⌘/Ctrl", "Z"], press: ["z"], mod: true, action: "undo", does: "Undo (add Shift to redo)" },
  { group: "Studio", keys: ["1", "2", "3"], press: ["1", "2", "3"], action: "mode", does: "Direct, Edit, Finish" },
  { group: "Studio", keys: ["/"], press: ["/"], action: "prompt", does: "Write to Kriya" },
  { group: "Studio", keys: ["Esc"], press: [], action: null, does: "Let go of the field, the selection and the marks" },
  { group: "Studio", keys: ["?"], press: [], action: null, does: "This list" },
]

/** The sheet, as a modal dialog; open() shows it and puts focus on Close. */
export function createShortcuts() {
  const groups = [...new Set(SHORTCUTS.map((row) => row.group))]
  const close = h("button", { type: "button", class: "btn", onclick: () => dialog.close() }, "Close")
  const dialog = h(
    "dialog",
    { class: "picker shortcuts", "aria-label": "Keyboard shortcuts" },
    h("h2", {}, "Keyboard shortcuts"),
    ...groups.map((group) =>
      h("section", { class: "keys-group", "aria-label": group }, h("p", { class: "keys-head" }, group), h("dl", { class: "keys" }, SHORTCUTS.filter((row) => row.group === group).flatMap((row) => [h("dt", {}, ...row.keys.flatMap((key, i) => [i ? " " : null, h("kbd", {}, key)])), h("dd", {}, row.does)]))),
    ),
    h("p", { class: "note small" }, "Keys work when no field has the focus."),
    h("div", { class: "row end" }, close),
  )
  // Escape always closes it, whatever the browser's rules for a dialog a key opened; and stops there
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return
    event.preventDefault()
    event.stopPropagation()
    dialog.close()
  })
  return {
    dialog,
    open() {
      if (!dialog.isConnected) document.body.append(dialog)
      if (!dialog.open) dialog.showModal()
      close.focus()
    },
  }
}
