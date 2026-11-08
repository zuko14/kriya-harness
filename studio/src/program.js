// Where the program is: the solver's timeline (from GET /projects/{id}/plan) as
// pieces of source, so the monitor knows which proxy and which source time to show
// at any timeline time, and a transcript word knows where it plays in the cut.

const rateOf = (speed) => (typeof speed === "number" ? { n: speed, d: 1 } : (speed ?? { n: 1, d: 1 }))

/** Picture pieces in timeline order; a source view is a one-piece program. */
export const programOf = (timeline) => [...(timeline?.picture ?? [])].sort((a, b) => a.at - b.at)
export const sourceProgram = (asset) => [{ clip: null, asset: asset.id, in: 0, out: asset.facts.duration, at: 0, end: asset.facts.duration, speed: { n: 1, d: 1 } }]

export const pieceAt = (pieces, t) => pieces.find((p) => t >= p.at && t < p.end) ?? (pieces.length && t >= pieces.at(-1).end ? pieces.at(-1) : null)

/** Source time shown at timeline time t inside a piece. */
export function sourceAt(piece, t) {
  if (piece.hold) return piece.in
  const { n, d } = rateOf(piece.speed)
  return Math.min(piece.out, piece.in + Math.round(((t - piece.at) * n) / d))
}

/** Where source time `s` of `asset` plays in the cut, or null if the cut doesn't use it. */
export function timelineAt(pieces, asset, s) {
  for (const p of pieces) {
    if (p.asset !== asset || p.hold || s < p.in || s >= p.out) continue
    const { n, d } = rateOf(p.speed)
    return p.at + Math.round(((s - p.in) * d) / n)
  }
  return null
}

export const durationOf = (pieces) => (pieces.length ? Math.max(...pieces.map((p) => p.end)) : 0)

/** Shot boundaries of the index, placed on the timeline where the cut shows them. */
export function shotMarks(pieces, shots) {
  const marks = []
  for (const shot of shots) {
    const at = timelineAt(pieces, shot.asset, shot.start)
    if (at !== null && at > 0) marks.push({ id: shot.id, at })
  }
  return marks
}
