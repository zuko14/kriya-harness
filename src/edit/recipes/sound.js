// The make's sound, arranged to the cut (TP10, CRAFT_UPGRADE §8, EDD-69), behind editing.craft and only
// when the make's own brief asks (audit rule 4). Every sound is still one Kriya wrote. Code knows where
// every join is, so an accent in the bed's key lands on each; a quiet bed comes from the take's own
// silence; J and L cuts let a voice lead or trail its picture only through silence, never into a word;
// and B-roll lands on the music's beat, which moves no word, since the picture under it doesn't move.

const FLICKS = 705_600_000
export const SPLIT_MAX = Math.round(0.15 * FLICKS) // how far a J or L cut leads or trails
const MARGIN = Math.round(0.04 * FLICKS) // kept clear of a word on either side
const QUIET_MIN = Math.round(1.2 * FLICKS) // the shortest gap between words that can be a room tone
const BEAT_REACH = Math.round(0.25 * FLICKS) // how far a B-roll may move to meet a beat, later only

/** The take's quietest stretch: its longest gap between words, less a margin at each end; null if none is long enough. */
export function quietStretch(words, asset, length) {
  const own = words.filter((w) => w.asset === asset).sort((a, b) => a.start - b.start)
  const gaps = []
  let from = 0
  for (const w of own) {
    gaps.push({ from, to: w.start })
    from = Math.max(from, w.end)
  }
  if (length !== undefined) gaps.push({ from, to: length })
  const best = gaps.filter((g) => g.to - g.from >= QUIET_MIN).sort((a, b) => b.to - b.from - (a.to - a.from) || a.from - b.from)[0]
  return best ? { from: best.from + Math.round(0.2 * FLICKS), to: best.to - Math.round(0.2 * FLICKS) } : null
}

/**
 * J and L cuts at the story's joins: the incoming clip's voice leads its picture (J) where the take is silent
 * before its first word, else the outgoing one trails (L) where it is silent after its last. Never more than
 * the silence less a margin, never more than SPLIT_MAX, so the extra sound is room, not speech.
 * @param {{ clip: string, asset: string, in: number, out: number }[]} played the story's clips as they play, in order
 */
export function splitOps(played, words) {
  const ops = []
  const sorted = [...words].sort((a, b) => a.start - b.start)
  for (let i = 1; i < played.length; i++) {
    const [a, b] = [played[i - 1], played[i]]
    // J: the incoming voice starts this much before its picture, through the silence before b's cut point
    const before = sorted.filter((w) => w.asset === b.asset && w.end <= b.in).at(-1)
    const lead = Math.min(SPLIT_MAX, b.in - (before?.end ?? 0) - MARGIN)
    if (lead >= MARGIN) {
      ops.push({ op: "trim", clip: b.clip, audioLead: Math.round(lead) })
      continue
    }
    // L: the outgoing voice trails its picture, through the silence after a's cut point
    const after = sorted.find((w) => w.asset === a.asset && w.start >= a.out)
    const lag = after ? Math.min(SPLIT_MAX, after.start - a.out - MARGIN) : 0
    if (lag >= MARGIN) ops.push({ op: "trim", clip: a.clip, audioLag: Math.round(lag) })
  }
  return ops
}

/** The music's beats where they play on the timeline, through a fitted bed's pieces and their crossfades. */
export function timelineBeats(item, beats) {
  if (!item) return []
  const own = beats.filter((b) => b.asset === item.asset).map((b) => b.t)
  const pieces = item.fit?.segments?.length ? item.fit.segments : [{ in: item.in, out: item.out }]
  const out = []
  let start = item.at
  for (const [i, piece] of pieces.entries()) {
    for (const t of own) if (t >= piece.in && t < piece.out) out.push(start + (t - piece.in))
    start += piece.out - piece.in - (i < pieces.length - 1 ? (item.fit?.crossfade ?? 0) : 0)
  }
  return out.filter((t) => t >= item.at && t < item.end).sort((x, y) => x - y)
}

/** A B-roll start moved later onto the nearest beat within reach, inside its host clip; unchanged otherwise. */
export function onBeat(start, hostEnd, length, beats) {
  const beat = beats.find((t) => t >= start && t - start <= BEAT_REACH)
  return beat !== undefined && beat + length <= hostEnd ? beat : start
}
