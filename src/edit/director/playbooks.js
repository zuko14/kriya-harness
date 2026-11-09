// The Director's playbooks (DIRECTOR_PLAYBOOKS.md, EDD-56): how each kind of video is edited,
// as data a person reviewed. No command, path, URL, model or price. The Director names the
// genre from the transcript; code fills what the plan left open; the person's words outrank both.
// Numbers are starting points to tune by KriyaEditBench, not facts about any editor.

const FLICKS = 705_600_000

export const PLAYBOOKS = {
  explainer: {
    label: "Science or explainer",
    rules: "Show what's hard to picture while the voice continues. Let a hard idea land before the next one. Keep the speaker for the hook, for anything personal and for the close.",
    settings: { captions: "clean", grade: "cinematic", music: "calm", cleanVoice: true },
    punchesPerMinute: 2,
    soundEvery: 4,
    scenes: true,
  },
  documentary: {
    label: "Documentary or place story",
    rules: "Slow, with room to look. What's named should be seen. Ambience and silence before score; few cuts, each for a reason.",
    settings: { captions: "story", grade: "warm", music: "calm", cleanVoice: true },
    punchesPerMinute: 0,
    soundEvery: 0,
    scenes: true,
  },
  podcast: {
    label: "Podcast or interview",
    rules: "Show who is talking, and sometimes who is listening. Follow the talk; don't cut on a timer. Let pauses and reactions breathe. Voice only, almost nothing else.",
    settings: { captions: "minimal", grade: "natural", music: "none", cleanVoice: true },
    punchesPerMinute: 1,
    soundEvery: 0,
    scenes: false,
  },
  tutorial: {
    label: "Tutorial",
    rules: "Tight on the action, no waiting. Show the step as it's said. Quiet sound; the viewer is following along.",
    settings: { captions: "clean", grade: "natural", music: "none", cleanVoice: true },
    punchesPerMinute: 2,
    soundEvery: 0,
    scenes: true,
  },
  opinion: {
    label: "Opinion or talking head",
    rules: "Brisk, with one real breath. Hook first. Punch in on the point, not on a timer. Numbers and names on screen. Keep every emotional beat on the face.",
    settings: { captions: "karaoke", grade: "vivid", music: "none", cleanVoice: true },
    punchesPerMinute: 4,
    soundEvery: 3,
    scenes: false,
  },
  promo: {
    label: "Promo or ad",
    rules: "One message. The offer early, an end on what to do next. Fast, led by the beat.",
    settings: { captions: "pop", grade: "vivid", music: "upbeat", cleanVoice: true },
    punchesPerMinute: 5,
    soundEvery: 2,
    scenes: true,
  },
  vlog: {
    label: "Vlog or personal story",
    rules: "Feeling first. No diagrams. Varied pace, the person's own B-roll, and quiet where the moment is quiet.",
    settings: { captions: "clean", grade: "warm", music: "warm", cleanVoice: true },
    punchesPerMinute: 1,
    soundEvery: 0,
    scenes: false,
  },
  montage: {
    label: "Music-led montage",
    rules: "The song leads. Cut on its beats, leave words out unless they matter.",
    settings: { captions: "none", grade: "vivid", music: "upbeat", cleanVoice: false },
    punchesPerMinute: 0,
    soundEvery: 0,
    scenes: false,
  },
}

export const GENRES = Object.keys(PLAYBOOKS)

/**
 * What the footage has and lacks, measured by code, so the Director plans from facts.
 * @returns {string[]} plain lines; nothing from the media but counts
 */
export function footageFacts(project, index, take) {
  const lines = []
  const videos = project.assets.filter((a) => a.kind === "video")
  const songs = project.assets.filter((a) => a.kind === "audio" && !/kriya-(?:music|sfx)-/.test(a.path ?? ""))
  const words = (index.words ?? []).filter((w) => w.asset === take?.id)
  lines.push(`${videos.length} video file${videos.length === 1 ? "" : "s"}${videos.length > 1 ? ": other clips can be B-roll, or angles if they were shot together" : ": no other footage to cut to"}.`)
  lines.push(songs.length ? `Sound files of the person's own in the bin, by id: ${songs.map((a) => a.id).join(", ")}; settings.song uses one.` : "No music of the person's own.")
  if (words.length > 1) {
    const minutes = (words.at(-1).end - words[0].start) / FLICKS / 60
    const numbers = words.filter((w) => /\d/.test(w.text)).length
    const pauses = words.slice(1).filter((w, i) => w.start - words[i].end > FLICKS).length
    lines.push(`${Math.round(minutes * 60)} seconds of speech, about ${Math.round(words.length / Math.max(minutes, 0.01))} words a minute, ${pauses} pause${pauses === 1 ? "" : "s"} over a second, ${numbers} spoken number${numbers === 1 ? "" : "s"}.`)
  }
  const faces = new Set((index.faces ?? []).filter((f) => f.asset === take?.id).map((f) => f.identity))
  if (faces.size) lines.push(`${faces.size} face${faces.size === 1 ? "" : "s"} seen in the take.`)
  return lines
}

/** The plan slot's extra lines. */
export function playbookPrompt(facts) {
  return [
    "Think like a top editor. Emotion and story come before rhythm; every cut, zoom and sound needs a reason in what is being said, and over-cutting is a fault. First work out from the transcript what kind of video this is, then what it has and what it lacks.",
    `What the footage has, measured: ${facts.join(" ")}`,
    `Set \`genre\` to one of these, and plan by its rules:\n${GENRES.map((id) => `- ${id} (${PLAYBOOKS[id].label}): ${PLAYBOOKS[id].rules}`).join("\n")}`,
    "Choose the caption look for this film in settings.captions (clean, karaoke, boxed, pop, story, minimal) and its highlight colour in settings.accent, once, for the whole film.",
    "Each of your `steps` says what you'll do and why, pointing at what the speaker says. Don't apply an effect because you can.",
  ]
}

const OPEN = { captions: "none", grade: "natural", music: "none", cutSound: "none" }
const isOpen = (settings, key) => settings[key] === undefined || settings[key] === null

/**
 * Fills what the plan left open from the genre's playbook; what's set stays. The caller applies
 * the person's words after this, so they outrank it.
 * @param {object} settings the plan's settings
 * @param {string} genre
 * @param {number} seconds speech in the take
 * @returns {object} new settings
 */
export function applyPlaybook(settings, genre, seconds = 0) {
  const book = PLAYBOOKS[genre]
  if (!book) return settings
  const out = { ...settings }
  for (const [key, value] of Object.entries(book.settings)) if (isOpen(out, key)) out[key] = value
  if (isOpen(out, "punches") && book.punchesPerMinute >= 0) out.punches = Math.min(8, Math.round((seconds / 60) * book.punchesPerMinute))
  // Restraint: a sound on some cuts, not all. A genre with none adds none, and the plan's own stays
  if (isOpen(out, "cutSound") && book.soundEvery > 0) out.cutSound = "whoosh"
  if (out.cutSound && out.cutSound !== OPEN.cutSound && book.soundEvery > 1) out.soundEvery = book.soundEvery
  return out
}
