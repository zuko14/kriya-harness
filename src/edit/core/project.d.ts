// The contract of a Kriya Edit Project (EDIT_ENGINE §3, DATA_MODEL §2).
// project.js validates it at runtime; these types are for readers and editors.

/** An integer count of 1/705,600,000 s. Never a float. */
export type Flicks = number
export type Rate = { n: number; d: number }
export type Edge = "start" | "end"

export type Anchor =
  | { word: string; edge: Edge; exact?: boolean }
  | { shot: string; edge?: Edge }
  | { beat: string }
  | { marker: string }
  | { clip: string; edge: Edge; offset?: Flicks }

/** A time is a number only when it truly is one; edits usually point at content. */
export type TimeRef = Flicks | Anchor

export type Author = "person" | "agent" | "code"
export type TrackRole = "base" | "broll" | "matte" | "overlay" | "caption" | "dialogue" | "sfx" | "music" | "ambience"
export type Box = { x: number; y: number; w: number; h: number }

export type Effect =
  | { type: "reframe"; mode: "subject" | "fixed"; x?: number; y?: number }
  | { type: "zoom"; scale: number; ease?: string; x?: number; y?: number } // x, y: focus in thousandths of the framed picture (ED11); ease "smooth" animates
  | { type: "matte"; model?: string }
  | { type: "grade"; lift?: number; gamma?: number; gain?: number; saturation?: number; ev?: number; match?: string }
  | { type: "lut"; asset: string }
  | { type: "stabilize"; strength?: number }
  | { type: "fade"; in?: Flicks; out?: Flicks }
  | { type: "transition"; kind: string; duration: Flicks }
  | { type: "caption"; words: string[]; text?: string; look: string; placement?: Box; emphasis: string[] }
  | { type: "block"; blockId: string; version: number; variables: Record<string, unknown> }
  | { type: "level"; db: number }
  | { type: "eq"; preset: string; strength?: number }
  | { type: "duck"; depth?: number; attack?: Flicks; release?: Flicks }
  | { type: "freeze"; at: TimeRef; duration: Flicks }

export type Clip = {
  id: string
  track: string
  /** null for a generated clip: a caption, a title, a punch-in */
  source: { asset: string; in: TimeRef; out: TimeRef } | null
  /** null on the base track: base clips lay end to end, in list order */
  at: TimeRef | null
  until?: TimeRef
  duration?: Flicks
  /** How far into the sound its peak falls, so the peak lands on the anchor */
  peak?: Flicks
  loop?: boolean
  effects: Effect[]
  speed: Rate
  linkGroup?: string
  /** J and L cuts: how far sound starts before, or ends after, the picture */
  audioLead?: Flicks
  audioLag?: Flicks
  createdBy: Author
}

export type Asset = {
  id: string
  kind: "video" | "audio" | "image" | "document" | "data" | "font" | "lut" | "reference"
  fingerprint: string
  sha256?: string
  path: string
  linked: boolean
  rights: "own" | "licensed" | "public_domain" | "unknown"
  rightsNote?: string
  role?: "aroll" | "broll" | "screen" | "music" | "sfx" | "logo"
  facts: {
    duration?: Flicks
    fps?: Rate | null
    vfr?: boolean
    width?: number
    height?: number
    hasAudio?: boolean
    sampleRate?: number
    channels?: number
    rotation?: number
    color?: { primaries: string; transfer: string; range: string; tagged: boolean; hdr: boolean }
    peak?: Flicks
  }
}

export type Sequence = {
  id: string
  name: string
  tracks: { id: string; role: TrackRole; order: number; muted: boolean; locked: boolean }[]
  markers: { id: string; name: string; at: TimeRef }[]
  clips: Clip[]
  parent?: string
}

export type Deliverable = {
  id: string
  preset: string
  size: { width: number; height: number }
  fps: Rate
  codec: string
  audio: string
  loudness: { lufs: number; tp: number }
  burnCaptions: boolean
  gates: string[]
}

export type EditBrief = {
  format: string
  targetDuration: Flicks
  audience?: string
  tone?: string
  mustKeep: string[]
  mustCut: string[]
  language?: string
  effort: "fast" | "best"
}

export type Version = { id: string; parent: string | null; name?: string; author: Author; opsRange: number[]; hash: string; at: string }

export type Project = {
  schema: 1
  id: string
  name: string
  canvas: { width: number; height: number; fps: Rate; color: { primaries: string; transfer: string; range: string }; workingBitDepth: number }
  assets: Asset[]
  sequences: Sequence[]
  active: string
  look: { id: string; caption: object; color: object; motion: object; sound: object; brand: object }
  deliverables: Deliverable[]
  brief?: EditBrief
  /** The next number for a new id, so a removed id is never handed out again */
  nextId: number
  head: string | null
  history: Version[]
}
