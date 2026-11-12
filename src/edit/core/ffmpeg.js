// FFmpeg arguments (EDIT_ENGINE §8.1): the compiler's one builder. An argument list
// for spawn, never a shell string. Text passes through one tested escape.

import { secondsArg } from "./time.js"
import { TRANSITIONS } from "./transitions.js"
import { fxSteps } from "./effects.js"

const BT709 = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"]
// On the frames too: FFmpeg can drop the output flags alone when it converts a format
const TAG_BT709 = "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv"

/** Escapes text for FFmpeg's two parsers: the filter's options, then the filtergraph. */
export function escapeFilterValue(text) {
  const option = String(text).replaceAll("\u0000", "").replace(/[\\':\s]/g, "\\$&")
  return option.replace(/[\\'[\],;\s]/g, "\\$&")
}

const filter = (name, options) => `${name}=${Object.entries(options).map(([key, value]) => `${key}=${escapeFilterValue(value)}`).join(":")}`

function absolute(path) {
  if (!path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path)) throw new RangeError(`an input must be an absolute path, got "${path}"`)
  return path
}

// The crop's x at the piece's time t (0 at item.in): straight lines between the path's
// points (ED11), so a reframe glides. Only the points where the slope changes are kept,
// so a hold or a steady move is one piece of the expression. faces.js maps the same way.
// shortcut: t is the output's clock, so a sped-up piece follows its path at 1×; reframed pieces aren't retimed yet
function cropX(crop, origin) {
  const knots = crop.filter((p, i) => i === 0 || i === crop.length - 1 || (p.x - crop[i - 1].x) * (crop[i + 1].t - p.t) !== (crop[i + 1].x - p.x) * (p.t - crop[i - 1].t))
  // The path holds its first x before its first point and its last x after its last, so flat ends add nothing
  while (knots.length > 1 && knots.at(-1).x === knots.at(-2).x) knots.pop()
  while (knots.length > 1 && knots[0].x === knots[1].x) knots.shift()
  if (knots.length === 1) return String(knots[0].x)
  const at = (point) => secondsArg(point.t - origin)
  // A point before the piece starts has a negative time, which secondsArg doesn't print
  const since = (point) => (point.t >= origin ? `t-${at(point)}` : `t+${secondsArg(origin - point.t)}`)
  const pieces = knots.slice(1).map((point, i) => [at(point), `${knots[i].x}+(${point.x - knots[i].x})*(${since(knots[i])})/${secondsArg(point.t - knots[i].t)}`])
  if (knots[0].t > origin) pieces.unshift([at(knots[0]), String(knots[0].x)])
  return pieces.reduceRight((rest, [until, value]) => `if(lt(t,${until}),${value},${rest})`, String(knots.at(-1).x))
}

const EASE = 0.3 // seconds a smooth punch-in takes to arrive and to leave

// A punch-in with a focus or a smooth ease (ED11): zoompan on the finished frame, one
// frame out per frame in. z eases with smoothstep over EASE at each end of the zoom.
// shortcut: zoompan crops on whole pixels, so a slow zoom can shimmer; a sub-pixel scaler replaces it if a gate sees it
function zoomSteps(zoom, width, height, fps) {
  const rate = `${fps.n}/${fps.d}`
  let z = String(zoom.scale)
  if (zoom.ease === "smooth") {
    const t = `(in*${fps.d}/${fps.n}+${secondsArg(zoom.since)})`
    const ramp = `clip(min(${t},${secondsArg(zoom.length)}-${t})/${EASE},0,1)`
    z = `1+${zoom.scale - 1}*${ramp}*${ramp}*(3-2*${ramp})`
  }
  const [fx, fy] = [(zoom.x ?? 500) / 1000, (zoom.y ?? 500) / 1000]
  return [filter("fps", { fps: rate }), filter("zoompan", { z, x: `clip(${fx}*iw-iw/zoom/2,0,iw-iw/zoom)`, y: `clip(${fy}*ih-ih/zoom/2,0,ih-ih/zoom)`, d: 1, s: `${width}x${height}`, fps: rate })]
}

/** True when a zoom needs zoompan rather than a plain centred crop. */
export const animatedZoom = (zoom) => zoom !== undefined && (zoom.x !== undefined || zoom.ease === "smooth")

// A colour match (ED13) is its baked .cube, measured by the Engine; then the person's own values.
// shortcut: eq only approximates lift, gain and ev; a full lift/gamma/gain grade isn't built
function gradeSteps({ gamma, saturation, lift, gain, ev, match, temperature, vibrance, vignette }, input) {
  const steps = match ? [filter("lut3d", { file: input(match.key) })] : []
  if (temperature !== undefined) steps.push(filter("colortemperature", { temperature: Math.round(temperature) }))
  const brightness = (lift ?? 0) + (ev ?? 0) / 8
  const options = Object.fromEntries(Object.entries({ gamma, saturation, brightness: brightness || undefined, contrast: gain }).filter(([, value]) => value !== undefined))
  if (Object.keys(options).length) steps.push(filter("eq", options))
  if (vibrance !== undefined) steps.push(filter("vibrance", { intensity: vibrance.toFixed(3) }))
  // A lens-like darkening at the edges: the angle grows with the strength
  if (vignette) steps.push(filter("vignette", { angle: (0.25 + 0.45 * vignette).toFixed(3) }))
  return steps
}

/** Colour first (EX-10): an untagged source gets its tags, and HDR maps down through a LUT. */
export function colourSteps(color, toneMap) {
  if (!color) return []
  if (!color.tagged) return [filter("setparams", { color_primaries: "bt709", color_trc: "bt709", colorspace: "bt709", range: "tv" })]
  if (!color.hdr) return []
  if (!toneMap) throw new RangeError(`this render has no tone-map for ${color.transfer}`)
  return [filter("scale", { in_color_matrix: "bt2020", in_range: "tv", out_range: "pc" }), "format=gbrp16le", filter("lut3d", { file: toneMap(color.transfer) }), filter("scale", { out_color_matrix: "bt709", out_range: "tv" }), "format=yuv420p"]
}

export const PLATE = "0x101014" // the bars of a fitted picture: near black, as the Studio's stage is

/**
 * The `frame` effect (TP2, ASSEMBLY_AND_INTENT §6.2): the whole picture inside the frame. `fit` puts
 * it on bars; `blur` puts it over a blurred, darkened copy of itself that fills the frame. One
 * step of a comma chain: the blur's two branches carry labels of their own (`n` keeps them apart).
 * shortcut: the bars are one colour, not the look's plate; a look that sets one replaces PLATE
 */
export function frameSteps(frame, width, height, n) {
  const whole = filter("scale", { w: width, h: height, force_original_aspect_ratio: "decrease", force_divisible_by: 2 })
  if (frame.mode === "fit") return [whole, filter("pad", { w: width, h: height, x: "(ow-iw)/2", y: "(oh-ih)/2", color: PLATE })]
  const behind = [filter("scale", { w: width, h: height, force_original_aspect_ratio: "increase" }), filter("crop", { w: width, h: height }), filter("boxblur", { luma_radius: Math.max(2, Math.round(Math.min(width, height) / 24)), luma_power: 2 }), filter("eq", { brightness: -0.12, saturation: 0.9 })].join(",")
  return [`split[fa${n}][fb${n}];[fa${n}]${behind}[fbg${n}];[fb${n}]${whole}[ffg${n}];[fbg${n}][ffg${n}]${filter("overlay", { x: "(W-w)/2", y: "(H-h)/2" })}`]
}

function pictureChain(item, width, height, plan, { input, toneMap, uid }) {
  const steps = []
  // The input already seeks to item.in, so a long file isn't decoded from its start
  if (item.hold) {
    steps.push(filter("trim", { end_frame: 1 }), "setpts=PTS-STARTPTS", filter("tpad", { stop_mode: "clone", stop_duration: secondsArg(item.end - item.at) }))
  } else {
    steps.push(filter("trim", { duration: secondsArg(item.out - item.in) }), "setpts=PTS-STARTPTS")
    if (item.speed.n !== item.speed.d) steps.push(`setpts=${item.speed.d}/${item.speed.n}*PTS`)
  }
  steps.push(...colourSteps(item.color, toneMap))
  if (item.crop?.length) steps.push(filter("crop", { w: `ih*${plan.canvas.width}/${plan.canvas.height}`, h: "ih", x: cropX(item.crop, item.in), y: 0 }))
  if (item.zoom && !animatedZoom(item.zoom)) steps.push(filter("crop", { w: `iw/${item.zoom.scale}`, h: `ih/${item.zoom.scale}` }))
  const frame = item.effects.find((e) => e.type === "frame")
  if (frame) steps.push(...frameSteps(frame, width, height, uid?.() ?? 0))
  else steps.push(filter("scale", { w: width, h: height, force_original_aspect_ratio: "increase" }), filter("crop", { w: width, h: height }))
  if (animatedZoom(item.zoom)) steps.push(...zoomSteps(item.zoom, width, height, plan.output.fps))
  for (const effect of item.effects) {
    if (effect.type === "lut") steps.push(filter("lut3d", { file: input(effect.asset) }))
    else if (effect.type === "grade") steps.push(...gradeSteps(effect, input))
    // TP5: a registry effect, from numbers only; stabilize drawn at last (EH-57: the operation always stored it)
    else if (effect.type === "fx") steps.push(...fxSteps(effect, { width, height, uid: uid ?? (() => 0), origin: effect.origin ?? 0, span: effect.span ?? 0 }))
    else if (effect.type === "stabilize") steps.push("deshake")
    else if (effect.type !== "reframe" && effect.type !== "frame") throw new RangeError(`this render can't do ${effect.type} yet`)
  }
  // Square pixels on every piece: a zoom's crop leaves a fractional aspect, and concat refuses a mix (found in ED7)
  steps.push("setsar=1", TAG_BT709)
  return steps.join(",")
}

/**
 * The speaker's matte as a grey mask (EDD-49): a head ellipse and shoulders under the
 * face box, white inside. shortcut: drawn from the face box, not segmented; MediaPipe's
 * selfie segmenter replaces it when the runtime ships it.
 */
export function matteMask({ x, y, w, h }) {
  const cx = x + w / 2
  const cy = y + h * 0.45
  const head = `lte(pow((X-${cx})/${(w * 0.62).toFixed(2)},2)+pow((Y-${cy})/${(h * 0.78).toFixed(2)},2),1)`
  const top = y + h * 0.9
  const body = `gte(Y,${top.toFixed(2)})*lte(abs(X-${cx}),min(${(w * 0.6).toFixed(2)}+(Y-${top.toFixed(2)})*0.9,${(w * 1.7).toFixed(2)}))`
  return `255*gt(${head}+${body},0)`
}

// ET-HR-01: whatever their start times, behind-the-speaker text, then cards, then captions on top
const depthOf = (part) => (part.node.behind === true && !part.front ? 0 : part.kind === "caption" ? 2 : 1)

/**
 * The argument list for one draft segment. Audio never lives in segments.
 * @param {object} plan
 * @param {object} segment
 * @param {{ input: (asset: string) => string, tile: (key: string) => string, output: string, encoder: string[], toneMap?: (transfer: string) => string, frames?: number[], without?: (part: object) => boolean }} io
 * paths come from the Engine, which knows the project; encoder is its typed choice.
 * frames: write only these frame numbers, as raw RGB on output (QG-09 reads pixels behind text);
 * without: tiles to leave out of the picture (QG-09 leaves out the text itself)
 */
export function segmentArgs(plan, segment, { input, tile, output, encoder, toneMap, frames, without }) {
  const { width, height } = plan.output
  const { node } = segment
  const inputs = []
  const inputFor = (path, seek = null) => inputs.push({ path: absolute(path), seek }) - 1
  let framed = 0
  const uid = () => framed++ // a label for each framed picture's two branches
  const tiles = node.tiles
    .map((part) => ({ ...plan.tiles.find((t) => t.key === part.key), ...part }))
    .filter((part) => !without?.(part))
    .map((part, i) => ({ part, i }))
    .sort((a, b) => depthOf(a.part) - depthOf(b.part) || a.i - b.i)
    .map(({ part }) => part)
  const chains = []

  const labels = node.picture.map((item, i) => {
    const chain = `[${inputFor(input(item.asset), item.in)}:v]${pictureChain(item, width, height, plan, { input, toneMap, uid })}`
    if (!item.enter) {
      chains.push(`${chain}[p${i}]`)
      return `[p${i}]`
    }
    // A transition in (transitions.js): the piece before, held on its last frame, under this
    // piece's first moments; then the rest of the piece. Its length is the piece's own, so the cut doesn't move
    const { kind, duration, from } = item.enter
    if (!Object.hasOwn(TRANSITIONS, kind)) throw new RangeError(`this render can't do a "${kind}" transition`)
    const length = secondsArg(duration)
    // xfade needs both sides alike: one frame rate, one pixel format, one time base
    const alike = `${filter("fps", { fps: `${plan.output.fps.n}/${plan.output.fps.d}` })},format=yuv420p,settb=AVTB`
    chains.push(`${chain},${alike},split[ph${i}][pt${i}]`)
    chains.push(`[${inputFor(input(from.asset), from.in)}:v]${pictureChain(from, width, height, plan, { input, toneMap, uid })},${alike}[pf${i}]`)
    chains.push(`[ph${i}]${filter("trim", { end: length })},setpts=PTS-STARTPTS[pa${i}]`)
    chains.push(`[pf${i}][pa${i}]${filter("xfade", { transition: TRANSITIONS[kind], duration: length, offset: 0 })}[px${i}]`)
    chains.push(`[pt${i}]${filter("trim", { start: length })},setpts=PTS-STARTPTS[pb${i}]`)
    chains.push(`[px${i}][pb${i}]concat=n=2:v=1:a=0,setsar=1,${TAG_BT709}[p${i}]`)
    return `[p${i}]`
  })
  let current = labels[0]
  if (labels.length > 1) {
    chains.push(`${labels.join("")}concat=n=${labels.length}:v=1:a=0[base]`)
    current = "[base]"
  }

  let step = 0
  const layer = (from, at, end) => {
    const next = `[v${step++}]`
    // End-exclusive: `between` includes its end, which showed a layer one frame too long (found in ED8)
    chains.push(`${current}${from}${filter("overlay", { enable: `gte(t,${secondsArg(Math.max(0, at))})*lt(t,${secondsArg(end)})` })}${next}`)
    current = next
  }
  node.overlays.forEach((item, i) => {
    chains.push(`[${inputFor(input(item.asset), item.in)}:v]${pictureChain(item, width, height, plan, { input, toneMap, uid })},setpts=PTS+${secondsArg(item.at)}/TB[o${i}]`)
    layer(`[o${i}]`, item.at, item.end)
  })

  // An effect over a stretch of the cut (TP5): the picture split, the effect on one copy, laid back over its window
  for (const [i, adjust] of (node.adjust ?? []).entries()) {
    const steps = fxSteps(adjust.fx, { width, height, uid, origin: adjust.fx.origin ?? 0, span: adjust.fx.span ?? 0 })
    if (!steps.length) continue
    chains.push(`${current}split[aj${i}][ak${i}]`, `[ak${i}]${steps.join(",")}[al${i}]`)
    current = `[aj${i}]`
    layer(`[al${i}]`, adjust.at, adjust.end)
  }

  // The speaker, cut from the picture before anything covers it, goes back over the text behind
  const mattes = node.mattes ?? []
  const keeps = []
  if (mattes.length) {
    const labels = mattes.map((_, i) => `[mk${i}]`)
    chains.push(`${current}split=${mattes.length + 1}[mb]${labels.join("")}`)
    current = "[mb]"
    keeps.push(...labels)
  }
  const drawMattes = () => {
    mattes.forEach((matte, i) => {
      const length = secondsArg(segment.end - segment.start)
      chains.push(`${filter("color", { c: "black", s: `${width}x${height}`, r: `${plan.output.fps.n}/${plan.output.fps.d}`, d: length })},format=gray,${filter("geq", { lum: matteMask(matte.box) })}[mm${i}]`)
      chains.push(`${keeps[i]}[mm${i}]alphamerge[ms${i}]`)
      layer(`[ms${i}]`, matte.at, matte.end)
    })
  }

  let matted = mattes.length === 0
  for (const part of tiles) {
    if (!matted && depthOf(part) > 0) {
      drawMattes()
      matted = true
    }
    if (part.kind === "caption" && part.node.style?.burn === true) {
      const next = `[v${step++}]`
      const box = part.node.placement
      chains.push(`${current}${filter("drawtext", { text: part.node.text, expansion: "none", x: box?.x ?? 0, y: box?.y ?? 0, enable: `gte(t,${secondsArg(Math.max(0, part.at))})*lt(t,${secondsArg(part.end)})` })}${next}`)
      current = next
    } else {
      const label = `[t${step}]`
      // A tile that began in an earlier segment starts part way through
      chains.push(`[${inputFor(tile(part.key))}:v]${filter("trim", { start: secondsArg(Math.max(0, -part.at)) })},setpts=PTS-STARTPTS+${secondsArg(Math.max(0, part.at))}/TB${label}`)
      layer(label, part.at, part.end)
    }
  }
  if (!matted) drawMattes()

  // TP7 (CRAFT §5.4): the type kit's bar and logo bug, over everything and across the cut, so each
  // segment draws its share of them on the cut's own clock (from: where this segment starts)
  if (node.brand) {
    const { bar, bug, from } = node.brand
    const draw = (chain) => {
      const next = `[v${step++}]`
      chains.push(`${current}${chain}${next}`)
      current = next
    }
    if (bar) {
      const h = Math.max(4, Math.round(height * 0.008))
      const y = height > width ? 0 : height - h
      const total = secondsArg(bar.total)
      draw(filter("drawbox", { x: 0, y, w: width, h, color: `${bar.track}@0.35`, t: "fill" }))
      chains.push(`${filter("color", { c: bar.color, s: `${width}x${h}`, r: `${plan.output.fps.n}/${plan.output.fps.d}`, d: secondsArg(segment.end - segment.start) })}[bar]`)
      // The filled part grows with the cut's time: this segment's t plus where it starts
      draw(`[bar]${filter("overlay", { x: `-${width}+${width}*(t+${secondsArg(from)})/${total}`, y, eval: "frame" })}`)
      for (const at of bar.chapters ?? []) draw(filter("drawbox", { x: Math.max(0, Math.round((width * at) / bar.total) - 1), y, w: Math.max(2, Math.round(h * 0.6)), h, color: bar.track, t: "fill" }))
    }
    if (bug) {
      const side = Math.round(Math.min(width, height) * 0.11)
      const margin = Math.round(Math.min(width, height) * 0.04)
      chains.push(`[${inputFor(input(bug.asset))}:v]${filter("scale", { w: side, h: side, force_original_aspect_ratio: "decrease" })},format=rgba[bug]`)
      draw(`[bug]${filter("overlay", { x: bug.corner.endsWith("r") ? `W-w-${margin}` : margin, y: bug.corner.startsWith("b") ? `H-h-${margin}` : margin, eof_action: "repeat" })}`)
    }
  }

  const head = ["-nostdin", "-hide_banner", ...inputs.flatMap(({ path, seek }) => [...(seek === null ? [] : ["-ss", secondsArg(seek)]), "-protocol_whitelist", "file,pipe", "-i", path])]
  if (frames) {
    chains.push(`${current}${filter("select", { expr: frames.map((n) => `eq(n,${n})`).join("+") })},format=rgb24[still]`)
    return [...head, "-filter_complex", chains.join(";"), "-map", "[still]", "-an", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", output]
  }

  return [
    "-nostdin",
    "-hide_banner",
    ...inputs.flatMap(({ path, seek }) => [...(seek === null ? [] : ["-ss", secondsArg(seek)]), "-protocol_whitelist", "file,pipe", "-i", path]),
    "-filter_complex",
    chains.join(";"),
    "-map",
    current,
    "-an",
    ...BT709,
    "-r",
    `${plan.output.fps.n}/${plan.output.fps.d}`,
    "-t",
    secondsArg(segment.end - segment.start),
    ...encoder,
    "-y",
    output,
  ]
}

// The sound lives in mix.js (ED9): buses, voice clean, music fit, band ducking
export { audioArgs, stemsMixArgs } from "./mix.js"

/** EDD-12: the proxy. GOP 30 with no B-frames, measured frame-accurate in EX-03; timestamps are kept, so a VFR source doesn't drift. */
export function proxyArgs({ source, output, encoder, color, toneMap }) {
  const steps = [...colourSteps(color, toneMap), filter("scale", { w: 960, h: 540, force_original_aspect_ratio: "decrease", force_divisible_by: 2 }), "format=yuv420p", TAG_BT709]
  return ["-nostdin", "-hide_banner", "-protocol_whitelist", "file,pipe", "-i", absolute(source), "-vf", steps.join(","), "-fps_mode", "passthrough", ...encoder, "-g", "30", "-bf", "0", "-b:v", "1500k", ...BT709, "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-y", output]
}

/** A small copy of a finished file for Kriya: a fixed bitrate, so its size is known ahead (EH-23). */
export function previewArgs({ source, output, encoder, videoKbps, audioKbps }) {
  return ["-nostdin", "-hide_banner", "-protocol_whitelist", "file,pipe", "-i", absolute(source), "-vf", "scale=-2:'min(720,ih)'", ...encoder, "-b:v", `${videoKbps}k`, "-maxrate", `${videoKbps}k`, "-bufsize", `${videoKbps * 2}k`, "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", `${audioKbps}k`, "-movflags", "+faststart", "-y", output]
}

/** A few seconds of a take for a decision card (TAVI_INTEGRATION §5): small, and quick to open. */
export function clipArgs({ source, output, encoder, fromSeconds, seconds }) {
  return ["-nostdin", "-hide_banner", "-protocol_whitelist", "file,pipe", "-ss", fromSeconds.toFixed(3), "-t", seconds.toFixed(3), "-i", absolute(source), "-vf", "scale=-2:'min(360,ih)'", ...encoder, "-b:v", "400k", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", "-y", output]
}

/** Mono, at a rate peaks can be read from, on stdout. */
export const peakArgs = ({ source, rate }) => ["-nostdin", "-hide_banner", "-protocol_whitelist", "file,pipe", "-i", absolute(source), "-vn", "-ac", "1", "-ar", String(rate), "-f", "s16le", "pipe:1"]

/** One sprite sheet of thumbnails, `every` seconds apart. */
export const thumbArgs = ({ source, output, every, columns, rows }) => ["-nostdin", "-hide_banner", "-protocol_whitelist", "file,pipe", "-i", absolute(source), "-vf", `fps=1/${every},scale=160:-2,tile=${columns}x${rows}`, "-frames:v", "1", "-y", output]

/** Joins segments by stream copy and muxes the one audio track. `list` is a concat file Kriya wrote. */
export const joinArgs = ({ list, audio, output }) => ["-nostdin", "-hide_banner", "-protocol_whitelist", "file,pipe", "-f", "concat", "-safe", "1", "-i", absolute(list), "-protocol_whitelist", "file,pipe", "-i", absolute(audio), "-map", "0:v", "-map", "1:a", "-c", "copy", "-movflags", "+faststart", "-y", output]

/** Muxes a master's picture and its audio. */
export const muxArgs = ({ video, audio, output }) => ["-nostdin", "-hide_banner", "-protocol_whitelist", "file,pipe", "-i", absolute(video), "-protocol_whitelist", "file,pipe", "-i", absolute(audio), "-map", "0:v", "-map", "1:a", "-c", "copy", "-movflags", "+faststart", "-y", output]
