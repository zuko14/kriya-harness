// The program monitor (STUDIO_APP_AND_BROWSER §4, its Canvas 2D path): proxies play
// through <video> elements that are never shown; each frame is drawn to one canvas
// with the cut's crop, the person's zoom and guides. Two elements per asset, used by
// alternate pieces, so the next piece is already seeked when a cut arrives. Nothing
// is rendered: this is a preview of the plan, and it says so.

import { createSound, createTileLayer } from "./live.js"
import { blurFilter, frameRects, gainOf, gradeFilter, itemAt, PLATE, transitionAt, transitionMix } from "./preview.js"
import { pieceAt, sourceAt } from "./program.js"
import { FLICKS, frameFlicks, snap } from "./time.js"

const LONG_SIDE = 1280

/**
 * @param {{ canvas: HTMLCanvasElement, urlOf: (assetId: string) => string, assetOf: (id: string) => object, onTime: (t: number) => void, onRate: (rate: number) => void, tileUrl?: (key: string) => string }} options
 * tileUrl: editing.livePreview is on (TP3), and a program loaded with a `preview` draws the film:
 * tiles, transitions, framing, looks and sound. Without it, nothing below the first branch runs
 */
export function createMonitor({ canvas, urlOf, assetOf, onTime, onRate, tileUrl }) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  const videos = new Map()
  let pieces = []
  let fps = { n: 30, d: 1 }
  let duration = 0
  let t = 0
  let rate = 0
  let shape = { width: 1920, height: 1080 }
  let zoom = 1
  let guides = false
  let loop = 0 // bumps on every rate change, so an old loop stops
  let shown = null // { asset, source }: what the canvas holds now
  // The live preview (TP3): the draft plan's picture, tiles and sound, or null as before
  let live = null
  const tiles = tileUrl ? createTileLayer({ canvas, urlOf: tileUrl }) : null
  const sound = tileUrl ? createSound({ urlOf }) : null
  const scratch = tileUrl ? [document.createElement("canvas"), document.createElement("canvas")] : null
  const held = new Map() // "<asset>@<source>" → the held frame under a transition, at the file's own size

  function videoFor(index) {
    const piece = pieces[index]
    const key = `${piece.asset}:${index % 2}`
    if (!videos.has(key)) {
      const video = document.createElement("video")
      Object.assign(video, { muted: true, preload: "auto", playsInline: true, crossOrigin: "anonymous", src: urlOf(piece.asset) })
      videos.set(key, video)
    }
    return videos.get(key)
  }

  // Seconds for the element: the middle of the wanted source frame, so a seek can't land a frame early
  function seconds(piece, source) {
    const own = assetOf(piece.asset)?.facts?.fps ?? fps
    return (source + frameFlicks(own) / 2) / FLICKS
  }

  function size() {
    const scale = Math.min(1, LONG_SIDE / Math.max(shape.width, shape.height))
    const width = Math.round(shape.width * scale)
    const height = Math.round(shape.height * scale)
    if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height })
  }

  // A live picture on one scratch canvas: its framing (core/ffmpeg.js frameSteps), ungraded
  function picture(target, image, iw, ih, item) {
    const { width, height } = canvas
    if (target.width !== width || target.height !== height) Object.assign(target, { width, height })
    const c = target.getContext("2d")
    // A fitted picture shrinks the proxy a lot: the default smoothing aliases fine detail (measured in ET-PV-01)
    c.imageSmoothingQuality = "high"
    c.fillStyle = "#000"
    c.fillRect(0, 0, width, height)
    const rects = frameRects(item?.frame, iw, ih, width, height, zoom, live.output)
    if (rects.plate) {
      c.fillStyle = PLATE
      c.fillRect(0, 0, width, height)
    }
    if (rects.behind) {
      c.filter = blurFilter(live.output.width, live.output.height, width / live.output.width)
      c.drawImage(image, rects.behind.x, rects.behind.y, rects.behind.w, rects.behind.h)
      c.filter = "none"
    }
    c.drawImage(image, rects.picture.x, rects.picture.y, rects.picture.w, rects.picture.h)
    return target
  }

  // The film as the draft draws it at timeline time `at`: the look over the framed picture; in a
  // transition, the held frame and the incoming one mixed as FFmpeg's xfade mixes them
  function drawLive(video, at) {
    const { width: W, height: H } = canvas
    const item = itemAt(live.picture, at)
    const into = transitionAt(live.picture, at)
    const still = into && held.get(`${into.asset}@${into.source}`)
    // A grade and any effect the monitor can approximate (TP5), the clip's own and a stretch's at this time
    const extra = [...(item?.fx ?? []), ...(live.adjust ?? []).filter((a) => at >= a.at && at < a.end).flatMap((a) => a.fx)]
    const graded = (image, look) => {
      const base = gradeFilter(look)
      ctx.filter = extra.length ? `${base === "none" ? "" : `${base} `}${extra.join(" ")}` : base
      ctx.drawImage(image, 0, 0)
      ctx.filter = "none"
    }
    if (!still) return graded(picture(scratch[1], video, video.videoWidth, video.videoHeight, item), item?.grade)
    const a = picture(scratch[0], still, still.width, still.height, into.before)
    const b = picture(scratch[1], video, video.videoWidth, video.videoHeight, item)
    const mix = transitionMix(into.kind, into.progress)
    ctx.fillStyle = "#000"
    ctx.fillRect(0, 0, W, H)
    if (into.kind === "wipe") {
      graded(a, into.before?.grade)
      ctx.save()
      ctx.beginPath()
      ctx.rect(W * mix.edge, 0, W - W * mix.edge, H)
      ctx.clip()
      graded(b, item?.grade)
      return ctx.restore()
    }
    if (into.kind === "slide") {
      ctx.filter = gradeFilter(into.before?.grade)
      ctx.drawImage(a, -W * mix.shift, 0)
      ctx.filter = gradeFilter(item?.grade)
      ctx.drawImage(b, W * (1 - mix.shift), 0)
      ctx.filter = "none"
      return
    }
    // A·a + B·b + backdrop·bg in two plain draws, so each pixel is rounded once: the backdrop, B over it
    // at b/(b+bg), then A over both at a. b + bg = 1 − a, so the weights come out exact
    if (mix.bg > 0) {
      ctx.fillStyle = mix.backdrop
      ctx.fillRect(0, 0, W, H)
    }
    if (mix.b > 0) {
      ctx.globalAlpha = mix.b / (mix.b + mix.bg)
      ctx.filter = gradeFilter(item?.grade)
      ctx.drawImage(b, 0, 0)
    }
    if (mix.a > 0) {
      ctx.globalAlpha = mix.a
      ctx.filter = gradeFilter(into.before?.grade)
      const m = mix.magnify === undefined ? 1 : Math.max(0.01, mix.magnify)
      ctx.drawImage(a, (W - W * m) / 2, (H - H * m) / 2, W * m, H * m, 0, 0, W, H)
    }
    ctx.filter = "none"
    ctx.globalAlpha = 1
  }

  // Each transition's held frame, ready before it's needed: the piece before's last frame
  async function holdFrames(preview) {
    for (const item of preview.picture) {
      if (!item.enter || live !== preview) continue
      const key = `${item.enter.asset}@${item.enter.source}`
      if (held.has(key)) continue
      const video = document.createElement("video")
      Object.assign(video, { muted: true, preload: "auto", playsInline: true, crossOrigin: "anonymous", src: urlOf(item.enter.asset) })
      const own = assetOf(item.enter.asset)?.facts?.fps ?? fps
      await new Promise((done) => {
        video.addEventListener("seeked", done, { once: true })
        video.addEventListener("error", done, { once: true })
        video.currentTime = (item.enter.source + frameFlicks(own) / 2) / FLICKS
      })
      if (!video.videoWidth) continue
      const still = document.createElement("canvas")
      Object.assign(still, { width: video.videoWidth, height: video.videoHeight })
      still.getContext("2d").drawImage(video, 0, 0)
      held.set(key, still)
      video.removeAttribute("src")
    }
  }

  // The live preview draws only when the monitor shows the film in its own shape: tiles are laid out for it
  const liveFits = () => live && Math.abs(shape.width * live.output.height - shape.height * live.output.width) < shape.width
  function draw(video, piece, source, at) {
    size()
    const { width, height } = canvas
    ctx.fillStyle = "#000"
    ctx.fillRect(0, 0, width, height)
    if (live && video?.videoWidth && liveFits()) {
      drawLive(video, at)
      shown = { asset: piece.asset, source }
    } else if (video?.videoWidth) {
      // Cover the frame, as the render crops to the canvas; zoom from the centre
      const cover = Math.max(width / video.videoWidth, height / video.videoHeight) * zoom
      const w = video.videoWidth * cover
      const h = video.videoHeight * cover
      ctx.drawImage(video, (width - w) / 2, (height - h) / 2, w, h)
      shown = { asset: piece.asset, source }
    }
    if (guides) {
      ctx.strokeStyle = "rgb(255 255 255 / 0.55)"
      ctx.setLineDash([6, 6])
      ctx.lineWidth = 1
      for (const inset of [0.05, 0.1]) ctx.strokeRect(width * inset, height * inset, width * (1 - 2 * inset), height * (1 - 2 * inset))
      ctx.setLineDash([])
    }
    if (tiles) tiles.sync(liveFits() ? live.tiles : [], at, live?.output)
  }

  const blank = () => {
    size()
    ctx.fillStyle = "#000"
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    shown = null
    tiles?.clear()
  }

  let seeking = 0 // the latest request wins; an older seek finishing late draws nothing
  let settled = Promise.resolve()
  /** Shows the frame at t, paused. Resolves when it's on the canvas. */
  function show(at) {
    const index = pieces.indexOf(pieceAt(pieces, at))
    if (index < 0) return Promise.resolve(blank())
    const piece = pieces[index]
    const source = sourceAt(piece, at)
    const video = videoFor(index)
    const target = seconds(piece, source)
    const mine = ++seeking
    const job = new Promise((done) => {
      const finish = () => {
        if (seeking === mine) draw(video, piece, source, at)
        done()
      }
      if (video.readyState >= 2 && Math.abs(video.currentTime - target) < 1e-4) return finish()
      video.addEventListener("seeked", finish, { once: true })
      video.currentTime = target
    })
    settled = job
    // Prime the next piece's element on its own start
    if (pieces[index + 1]) {
      const next = videoFor(index + 1)
      if (next !== video) next.currentTime = seconds(pieces[index + 1], pieces[index + 1].in)
    }
    return job
  }

  function stopAll() {
    for (const video of videos.values()) {
      video.pause()
      video.muted = true
    }
  }

  function setTime(next, notify = true) {
    t = Math.min(Math.max(0, next), Math.max(0, duration - frameFlicks(fps)))
    if (notify) onTime(t)
  }

  // Forward: the element plays, with sound; its frame clock moves the playhead
  function playForward(run) {
    let index = pieces.indexOf(pieceAt(pieces, t))
    if (index < 0) return setRate(0)
    const start = (i, from) => {
      const piece = pieces[i]
      const video = videoFor(i)
      video.currentTime = seconds(piece, sourceAt(piece, from))
      video.playbackRate = rate
      video.muted = false
      // The voice at its level from the plan (TP3); a level above the take's own can't be played louder
      const voice = live?.audio.items.find((item) => item.bus === "dialogue" && item.asset === piece.asset && item.at < piece.end && piece.at < item.end)
      if (live) video.volume = voice?.db === undefined ? 1 : Math.min(1, gainOf(voice.db))
      const { n, d } = typeof piece.speed === "object" ? piece.speed : { n: 1, d: 1 }
      const frame = (_, meta) => {
        if (run !== loop) return
        const at = piece.at + Math.round(((Math.round(meta.mediaTime * FLICKS) - piece.in) * d) / n)
        if (at >= piece.end - frameFlicks(fps) / 2 || video.ended) {
          video.pause()
          video.muted = true
          if (!pieces[i + 1]) return setRate(0)
          index = i + 1
          setTime(pieces[index].at)
          return start(index, pieces[index].at)
        }
        draw(video, piece, sourceAt(piece, at), at)
        setTime(at)
        video.requestVideoFrameCallback(frame)
      }
      video.requestVideoFrameCallback(frame)
      // A newer rate pausing this element rejects this play(): only the current run may stop playback
      video.play().catch(() => run === loop && setRate(0))
    }
    start(index, t)
  }

  // Backward: no element plays in reverse, so the playhead moves and each frame is sought
  function playBackward(run) {
    let last = performance.now()
    const tick = async (now) => {
      if (run !== loop) return
      setTime(t - ((now - last) / 1000) * FLICKS * Math.abs(rate))
      last = now
      await show(t)
      if (t === 0) return setRate(0)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  function setRate(next) {
    if (next === rate && next !== 0) return
    rate = next
    const run = ++loop
    stopAll()
    onRate(rate)
    if (sound) liveFits() && rate > 0 ? sound.start(t, rate) : sound.stop()
    if (rate > 0) playForward(run)
    else if (rate < 0) playBackward(run)
    else {
      setTime(snap(t, fps))
      show(t)
    }
  }

  return {
    /** A new program: the cut's pieces, or one asset's source. `preview`: the draft's plan to draw (TP3), only for the cut. */
    load(nextPieces, { fps: nextFps, duration: nextDuration, shape: nextShape, preview }) {
      pieces = nextPieces
      if (tiles) {
        live = preview ?? null
        sound.load(live?.audio)
        tiles.clear()
        if (live) void holdFrames(live).then(() => rate === 0 && live === preview && show(t))
      }
      fps = nextFps
      duration = nextDuration
      if (nextShape) shape = nextShape
      ++loop
      stopAll()
      rate = 0
      onRate(0)
      setTime(Math.min(t, Math.max(0, duration - frameFlicks(fps))))
      return show(t)
    },
    seek(at) {
      if (rate !== 0) setRate(0)
      setTime(snap(at, fps))
      return show(t)
    },
    setRate,
    get time() {
      return t
    },
    get rate() {
      return rate
    },
    get shown() {
      return shown
    },
    /** Resolves once the latest seek is on the canvas. */
    get settled() {
      return settled
    },
    setShape(next) {
      shape = next
      return show(t)
    },
    setZoom(next) {
      zoom = next
      return show(t)
    },
    setGuides(on) {
      guides = on
      return show(t)
    },
    /** The live preview's state, for tests: the tile frames showing and the sound's gains at the playhead. */
    get live() {
      return tiles ? { on: Boolean(live && liveFits()), tiles: [...tiles.frames.keys()], sound: sound.state(t), held: held.size } : null
    },
    /** For scopes: the pixels on screen. */
    pixels: () => (canvas.width ? ctx.getImageData(0, 0, canvas.width, canvas.height) : null),
  }
}
