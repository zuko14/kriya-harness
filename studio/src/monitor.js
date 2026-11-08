// The program monitor (STUDIO_APP_AND_BROWSER §4, its Canvas 2D path): proxies play
// through <video> elements that are never shown; each frame is drawn to one canvas
// with the cut's crop, the person's zoom and guides. Two elements per asset, used by
// alternate pieces, so the next piece is already seeked when a cut arrives. Nothing
// is rendered: this is a preview of the plan, and it says so.

import { pieceAt, sourceAt } from "./program.js"
import { FLICKS, frameFlicks, snap } from "./time.js"

const LONG_SIDE = 1280

/**
 * @param {{ canvas: HTMLCanvasElement, urlOf: (assetId: string) => string, assetOf: (id: string) => object, onTime: (t: number) => void, onRate: (rate: number) => void }} options
 */
export function createMonitor({ canvas, urlOf, assetOf, onTime, onRate }) {
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

  function draw(video, piece, source) {
    size()
    const { width, height } = canvas
    ctx.fillStyle = "#000"
    ctx.fillRect(0, 0, width, height)
    if (video?.videoWidth) {
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
  }

  const blank = () => {
    size()
    ctx.fillStyle = "#000"
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    shown = null
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
        if (seeking === mine) draw(video, piece, source)
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
        draw(video, piece, sourceAt(piece, at))
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
    if (rate > 0) playForward(run)
    else if (rate < 0) playBackward(run)
    else {
      setTime(snap(t, fps))
      show(t)
    }
  }

  return {
    /** A new program: the cut's pieces, or one asset's source. */
    load(nextPieces, { fps: nextFps, duration: nextDuration, shape: nextShape }) {
      pieces = nextPieces
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
    /** For scopes: the pixels on screen. */
    pixels: () => (canvas.width ? ctx.getImageData(0, 0, canvas.width, canvas.height) : null),
  }
}
