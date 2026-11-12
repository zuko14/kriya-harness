// The intent frame on the Plan Card (TP4, ASSEMBLY_AND_INTENT §7): what Kriya understood, in
// plain words, what isn't in this cut, and the choices it left open with a default already
// picked. Pure: the page draws these strings; nothing here talks to the Host.

export const FIELD_LABELS = {
  format: "Format",
  seconds: "Length",
  captions: "Captions",
  grade: "Look",
  music: "Music",
  cleanVoice: "Clean the voice",
  cutSound: "Sound on each cut",
  introSound: "Sound into the story",
  punches: "Punch-ins",
  angles: "Two angles from one camera",
  broll: "B-roll from your clips",
  titles: "Title cards",
  ramps: "Speed ramps",
  transition: "Transitions",
}

/** A setting's value as a person reads it. */
export function valueText(field, value) {
  if (typeof value === "boolean") return value ? "yes" : "no"
  if (field === "seconds") return `${value} seconds`
  if (field === "punches") return `${value}`
  if (value === "none") return "none"
  return String(value)
}

/** One line of "What I understood": the setting, the value, the person's own words, and who read it. */
export function understoodLine(item) {
  const what = `${FIELD_LABELS[item.field] ?? item.field}: ${valueText(item.field, item.value)}`
  const words = item.evidence ? ` (you said "${item.evidence}")` : ""
  // Code and the model read it differently: code's reading stands, and the card says so
  const differs = item.by === "code" && item.model !== undefined ? `; read by Kriya's code, not as ${valueText(item.field, item.model)}` : ""
  return `${what}${words}${differs}`
}

/**
 * An answered question on the brief an approval sends, the way the Host's briefOf turns settings into one.
 * @returns {object} the brief, changed in place and returned
 */
export function answerOnBrief(brief, field, value) {
  const off = { captions: "none", grade: "natural", cutSound: "none", introSound: "none" }
  if (field === "music") {
    if (value === "none" || value === "reference") delete brief.music
    else brief.music = `generated:${value}`
  } else if (field === "transition") {
    if (value === "none") (delete brief.transition, delete brief.transitionAll)
    else brief.transition = value
  } else if (typeof value === "boolean") {
    if (value) brief[field] = true
    else delete brief[field]
  } else if (field === "broll") {
    if (value === "own") brief.broll = "own"
    else delete brief.broll
  } else if (off[field] === value) delete brief[field]
  else brief[field] = value
  return brief
}
