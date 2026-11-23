// Transitions (MOTION_GRAPHICS.md §6): how one clip arrives over the last frame of the one
// before it. The cut never moves: the outgoing clip's last frame is held underneath while the
// incoming clip comes in over its own first moments, so the sound, the captions and every
// word anchor stay where they were. The kinds are a fixed list; code names the FFmpeg
// transition, a model never does.

const FLICKS = 705_600_000

/** What a person or the Director may ask for → FFmpeg's xfade transition. */
export const TRANSITIONS = { fade: "fade", dip: "fadeblack", flash: "fadewhite", wipe: "wipeleft", slide: "slideleft", zoom: "zoomin" }
export const TRANSITION_LABELS = { fade: "Fade", dip: "Dip to black", flash: "Flash", wipe: "Wipe", slide: "Slide", zoom: "Zoom" }
export const TRANSITION_MIN = Math.round(0.2 * FLICKS)
export const TRANSITION_MAX = Math.round(0.8 * FLICKS)
export const TRANSITION_DEFAULT = Math.round(0.3 * FLICKS)

/** A length inside the allowed range; anything else is the default. */
export const transitionLength = (duration) => (Number.isSafeInteger(duration) ? Math.min(TRANSITION_MAX, Math.max(TRANSITION_MIN, duration)) : TRANSITION_DEFAULT)
