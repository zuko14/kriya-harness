// The Studio's clock: integer flicks everywhere, seconds only at the <video> element.
// Transport is a small pure reducer, so the keyboard is testable without a browser.

export const FLICKS = 705_600_000

/** One frame in flicks; whole for every common rate, including 30000/1001. */
export const frameFlicks = (fps) => (FLICKS * fps.d) / fps.n
export const frameOf = (t, fps) => Math.floor(t / frameFlicks(fps) + 1e-9)
export const snap = (t, fps) => Math.round(frameOf(t, fps) * frameFlicks(fps))

/** "00:12.40" style, for people; never parsed back. */
export function timecode(t, fps) {
  const total = Math.max(0, t) / FLICKS
  const minutes = Math.floor(total / 60)
  const seconds = Math.floor(total % 60)
  const frame = frameOf(Math.max(0, t) - Math.floor(total) * FLICKS, fps)
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(frame).padStart(2, "0")}`
}

export const RATES = [-2, -1, 0, 1, 2]

/** A key press → a transport or workspace action, or null. Editors' muscle memory first (UX_SPEC §10). */
export function keyAction(key, { shift = false, mod = false } = {}) {
  if (mod) return key === "z" || key === "Z" ? { type: shift ? "redo" : "undo" } : null
  switch (key) {
    case " ":
      return { type: "toggle" }
    case "k":
    case "K":
      return { type: "rate", rate: 0 }
    case "l":
    case "L":
      return { type: "faster" }
    case "j":
    case "J":
      return { type: "reverse" }
    case "ArrowRight":
      return { type: "step", frames: shift ? null : 1, seconds: shift ? 1 : null }
    case "ArrowLeft":
      return { type: "step", frames: shift ? null : -1, seconds: shift ? -1 : null }
    case "Home":
      return { type: "seek", t: 0 }
    case "1":
      return { type: "mode", mode: "direct" }
    case "2":
      return { type: "mode", mode: "edit" }
    case "3":
      return { type: "mode", mode: "finish" }
    case "/":
      return { type: "prompt" }
    case "s":
    case "S":
      return { type: "split" }
    case "Backspace":
    case "Delete":
      return { type: "delete" }
    case "i":
    case "I":
      return { type: "mark", edge: "in" }
    case "o":
    case "O":
      return { type: "mark", edge: "out" }
    default:
      return null
  }
}

/**
 * @param {{ t: number, rate: number }} state
 * @param {object} action from keyAction, or { type: "seek", t } / { type: "tick", t }
 * @param {{ fps: { n: number, d: number }, duration: number }} limits
 */
export function transport(state, action, { fps, duration }) {
  const last = Math.max(0, duration - frameFlicks(fps))
  const clamp = (t) => Math.min(Math.max(0, Math.round(t)), last)
  switch (action.type) {
    case "toggle":
      return { ...state, rate: state.rate === 0 ? 1 : 0 }
    case "rate":
      return { ...state, rate: action.rate }
    case "faster":
      return { ...state, rate: state.rate <= 0 ? 1 : 2 }
    case "reverse":
      return { ...state, rate: state.rate >= 0 ? -1 : -2 }
    case "step": {
      const by = action.frames !== null ? action.frames * frameFlicks(fps) : action.seconds * FLICKS
      return { rate: 0, t: clamp(snap(state.t, fps) + by) }
    }
    case "seek":
      return { ...state, t: clamp(action.t) }
    case "tick": {
      const t = clamp(action.t)
      // Playing off either end stops there
      return { t, rate: (t === 0 && state.rate < 0) || (t === last && state.rate > 0) ? 0 : state.rate }
    }
    default:
      return state
  }
}
