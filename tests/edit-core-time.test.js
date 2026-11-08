import assert from "node:assert/strict"
import { test } from "node:test"

import * as time from "../src/edit/core/time.js"

const { FLICKS, framesToFlicks, flicksToFrames, frameFlicks, samplesToFlicks, flicksToSamples, snapToFrame, scaleFlicks, timecode, secondsArg, fractionSeconds, clockTime, frameAtTimestamp } = time

const RATES = [
  [{ n: 24, d: 1 }, 29_400_000],
  [{ n: 24000, d: 1001 }, 29_429_400],
  [{ n: 25, d: 1 }, 28_224_000],
  [{ n: 30000, d: 1001 }, 23_543_520],
  [{ n: 30, d: 1 }, 23_520_000],
  [{ n: 60000, d: 1001 }, 11_771_760],
  [{ n: 60, d: 1 }, 11_760_000],
  [{ n: 120, d: 1 }, 5_880_000],
]
const AUDIO = [
  [44100, 16_000],
  [48000, 14_700],
  [96000, 7_350],
]
const THREE_HOURS = 3 * 3600 * FLICKS

test("ET-CORE-01: every rate in EDIT_ENGINE §2 is exact", () => {
  assert.equal(FLICKS, 705_600_000)
  for (const [rate, flicks] of RATES) assert.equal(frameFlicks(rate), flicks, `${rate.n}/${rate.d}`)
  for (const [hz, flicks] of AUDIO) assert.equal(samplesToFlicks(1, hz), flicks, `${hz}`)
})

test("ET-CORE-01: frame and sample round trips are exact across 3 hours", () => {
  for (const [rate, per] of RATES) {
    const last = Math.floor(THREE_HOURS / per)
    for (const frame of [0, 1, 2, 999, 1000, 1001, 86_399, 86_400, 172_801, last - 1, last]) {
      const t = framesToFlicks(frame, rate)
      assert.equal(t, frame * per)
      assert.ok(Number.isSafeInteger(t))
      assert.equal(flicksToFrames(t, rate), frame)
      assert.equal(flicksToFrames(t + per - 1, rate), frame, "the last flick of a frame is still that frame")
    }
  }
  for (const [hz, per] of AUDIO) {
    const last = 3 * 3600 * hz
    for (const sample of [0, 1, 47_999, 48_000, last - 1, last]) {
      assert.equal(flicksToSamples(samplesToFlicks(sample, hz), hz), sample)
      assert.equal(samplesToFlicks(sample, hz), sample * per)
    }
  }
})

test("ET-CORE-01: a rate that doesn't divide a flick still round-trips, with no drift", () => {
  const rate = { n: 11, d: 1 }
  assert.equal(frameFlicks(rate), null)
  let previous = -1
  for (let frame = 0; frame < 5000; frame++) {
    const t = framesToFlicks(frame, rate)
    assert.ok(t > previous)
    assert.equal(flicksToFrames(t, rate), frame)
    previous = t
  }
  assert.equal(framesToFlicks(11, rate), FLICKS)
})

test("ET-CORE-01: decimals, floats and bad rates are refused, never rounded", () => {
  assert.throws(() => framesToFlicks(1.5, { n: 30, d: 1 }), /whole/)
  assert.throws(() => flicksToFrames(0.5, { n: 30, d: 1 }), /whole/)
  assert.throws(() => framesToFlicks(1, { n: 29.97, d: 1 }), /rate/)
  assert.throws(() => framesToFlicks(1, { n: 30, d: 0 }), /rate/)
  assert.throws(() => samplesToFlicks(1, 44100.5), /rate/)
  assert.equal(time.isFlicks(1.5), false)
  assert.equal(time.isFlicks(Number.MAX_SAFE_INTEGER + 1), false)
  assert.equal(time.isFlicks(-1), true)
})

test("snapToFrame: floor, ceil and nearest land on frames", () => {
  const rate = { n: 30, d: 1 }
  const per = 23_520_000
  assert.equal(snapToFrame(per + 1, rate, "floor"), per)
  assert.equal(snapToFrame(per + 1, rate, "ceil"), per * 2)
  assert.equal(snapToFrame(per + 1, rate, "nearest"), per)
  assert.equal(snapToFrame(2 * per - 1, rate, "nearest"), 2 * per)
  assert.equal(snapToFrame(per, rate, "ceil"), per)
})

test("scaleFlicks: exact rational scaling without overflow", () => {
  assert.equal(scaleFlicks(THREE_HOURS, { n: 1, d: 2 }), THREE_HOURS / 2)
  assert.equal(scaleFlicks(THREE_HOURS, { n: 1001, d: 1000 }), (THREE_HOURS / 1000) * 1001)
  assert.equal(scaleFlicks(10, { n: 1, d: 3 }), 4, "rounds up so a clip never loses its tail")
})

test("edge conversions: exact strings, no float", () => {
  assert.equal(secondsArg(FLICKS + 1), "1.000000001")
  assert.equal(secondsArg(framesToFlicks(1, { n: 24000, d: 1001 })), "0.041708333")
  assert.equal(secondsArg(0), "0.000000000")
  assert.equal(fractionSeconds(frameFlicks({ n: 24000, d: 1001 })), "1001/24000s")
  assert.equal(fractionSeconds(0), "0s")
  assert.equal(fractionSeconds(FLICKS * 3), "3s")
  assert.equal(timecode(0, { n: 30, d: 1 }), "00:00:00:00")
  assert.equal(timecode(30 * 3661 + 7, { n: 30, d: 1 }), "01:01:01:07")
  assert.equal(timecode(24, { n: 24000, d: 1001 }), "00:00:01:00", "non-drop counts nominal frames")
  assert.equal(clockTime(FLICKS + 705_600 * 500, ","), "00:00:01,500")
  assert.equal(clockTime(3600 * FLICKS, "."), "01:00:00.000")
})

test("ET-CORE-02: VFR maps source time through the timestamp table", () => {
  // A phone's frames: uneven gaps, as ffprobe reports them
  const table = [0, 20_000_000, 45_000_000, 47_000_000, 90_000_000, 120_000_000]
  assert.equal(frameAtTimestamp(table, 0), 0)
  assert.equal(frameAtTimestamp(table, 19_999_999), 0)
  assert.equal(frameAtTimestamp(table, 20_000_000), 1)
  assert.equal(frameAtTimestamp(table, 46_000_000), 2)
  assert.equal(frameAtTimestamp(table, 47_000_000), 3)
  assert.equal(frameAtTimestamp(table, 500_000_000), 5, "after the last frame, the last frame")
  assert.equal(frameAtTimestamp(table, -1), 0)
  for (let i = 0; i < table.length; i++) assert.equal(frameAtTimestamp(table, table[i]), i)
})
