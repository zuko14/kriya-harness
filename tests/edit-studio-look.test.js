import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

import { FONTS } from "../studio/build.js"
import { ROOT } from "./helpers.js"

// The Studio's material (2026-11-12): the harness's glass over cloth and its three faces. What must stay true:
// the faces come from the Studio's own origin (its policy is 'self', no data: fonts), the same files the brand
// ships (OFL-1.1, in the notices), every glass pane has a solid fallback, and the monitor is never glass.

const css = readFileSync(join(ROOT, "studio/src/styles.css"), "utf8")
const server = readFileSync(join(ROOT, "src/edit/host/server.js"), "utf8")

test("ET-LOOK-01: the three faces are the brand's own files, served by the Host from the Studio's origin", () => {
  const brand = readFileSync(join(ROOT, "scripts/build-brand.js"), "utf8")
  for (const [name, from] of Object.entries(FONTS)) {
    assert.ok(brand.includes(from), `${name}: the same file the harness embeds`)
    assert.match(css, new RegExp(`src: url\\("/fonts/${name.replace(".", "\\.")}"\\) format\\("woff2"\\)`), `${name}: from this origin`)
    assert.match(server, new RegExp(`"/fonts/${name.replace(".", "\\.")}": \\["fonts/${name.replace(".", "\\.")}", "font/woff2"\\]`), `${name}: a route the Host serves`)
    if (existsSync(join(ROOT, "studio/dist/fonts"))) assert.ok(existsSync(join(ROOT, "studio/dist/fonts", name)), `${name}: built`)
  }
  assert.doesNotMatch(css, /url\(data:font|url\("data:font/, "no data: font: the Studio's policy is 'self'")
  const notices = readFileSync(join(ROOT, "THIRD_PARTY_NOTICES.md"), "utf8")
  for (const pkg of ["@fontsource-variable/geist", "@fontsource-variable/fraunces", "@fontsource-variable/jetbrains-mono"]) assert.ok(notices.includes(pkg), `${pkg} in the notices`)
})

test("ET-LOOK-02: glass has solid fallbacks, never sits on the monitor, and follows the brand's rules", () => {
  assert.match(css, /@media \(prefers-reduced-transparency: reduce\) \{ :root \{ --glass: var\(--sheet\); --glass-thick: var\(--sheet\); --blur: none; \} \}/)
  assert.match(css, /@supports not \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)\)/)
  assert.match(css, /@media \(prefers-contrast: more\)/)
  assert.match(css, /\.panel\.area-monitor::before \{ content: none; \}/, "the bay is solid")
  assert.match(css, /--bay: #262626;/, "a neutral grey: equal channels")
  assert.match(css, /--bay: #1f1f1f;/)
  // Glass on the pane's ::before, never a backdrop-filter on .panel itself (it would trap the Plan Card's fixed sheet)
  assert.doesNotMatch(css, /\.panel \{[^}]*backdrop-filter/)
  assert.match(css, /\.panel::before \{ content: ""; position: absolute; inset: 0; z-index: -1;/)
  // No all-caps labels in the material's layer
  const layer = css.slice(css.indexOf("The Studio's material"))
  assert.doesNotMatch(layer, /text-transform: uppercase/)
})
