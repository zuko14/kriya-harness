import assert from "node:assert/strict"
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { test } from "node:test"
import vm from "node:vm"

import { build } from "../scripts/build-brand.js"
import { ensureProfile, LINKED } from "../src/profiles.js"
import { freshHome, ROOT } from "./helpers.js"

// The Kriya look (plugins/brand/DESIGN.md): DeepSeek's brand row off,
// Kriya's plugin mounted, the theme token layer, the start screen, and the
// title. Checked by eye in a browser in H4 session 3; these keep it from
// regressing and fail first when a DSH bump moves what the theme relies on.

const recorded = (profile) => readFileSync(join(ROOT, "expected", `${profile}.dump.yml`), "utf8")
const require = createRequire(join(ROOT, "package.json"))
const dshClient = (name) =>
  readFileSync(join(require.resolve(`@deepseek-ai/${name}/package.json`), "..", "lib", "client.js"), "utf8")

test("the Web UI profile mounts Kriya's brand instead of DeepSeek's", () => {
  const yaml = recorded("kriya")
  assert.match(yaml, /- id: ui-brand-official\n {2}name: '@deepseek-ai\/dsh-client-ui-brand-official'\n {2}disabled: true\n/)
  assert.match(yaml, /- id: ui-brand-kriya\n {2}name: '@kriya-ai\/harness-brand'\n/)
  // DSH's preview notice is marked seen; Kriya shows its own beta notice
  assert.match(yaml, /- id: ui-settings-general\n.*\n {2}config:\n {4}welcomeNoticeVersion: 2026-09-28\.1\n/)
})

test("each profile links the brand package next to the bundle", () => {
  freshHome()
  const dir = ensureProfile("kriya")
  for (const name of Object.keys(LINKED))
    assert.ok(lstatSync(join(dir, "node_modules", ...name.split("/"))).isSymbolicLink(), name)
  const brand = JSON.parse(readFileSync(join(ROOT, "plugins", "brand", "package.json"), "utf8"))
  assert.equal(brand.name, "@kriya-ai/harness-brand")
  assert.equal(brand.exports["./client"], "./client.js")
  assert.equal(brand.dsh.client.platform, "web")
})

test("the built module is current and embeds the three fonts", () => {
  const built = readFileSync(join(ROOT, "plugins", "brand", "client.js"), "utf8")
  assert.equal(built, build())
  for (const family of ["KH Geist", "KH Fraunces", "KH JetBrains Mono"])
    assert.match(built, new RegExp(`font-family: "${family}"; .*src: url\\(data:font/woff2;base64,`))
  assert.doesNotMatch(built, /https?:\/\/(?!www\.w3\.org)/, "nothing is fetched from the network")
})

// Runs the browser half the way DSH's module loader would, with stand-ins
// for React, the slot registry, the theme service and the document
function loadClient() {
  let loaded
  const slots = { registered: [] }
  slots.inject = (_name, body) => {
    const result = typeof body === "function" ? body() : undefined
    if (result && typeof result[Symbol.iterator] === "function") for (const _ of result);
  }
  slots.register = ({ name }, component) => slots.registered.push({ name, component })
  const theme = { layers: [] }
  theme.overrideTokens = (source, tokens) => {
    theme.layers.push({ source, tokens })
    return () => {}
  }
  // DSH's locale runtime: a catalog, per-namespace dictionaries, the
  // active locale and its subscribers (dsh-client-locale)
  const locale = { languages: ["zh", "en"], dicts: [], active: "zh", listeners: new Set() }
  locale.addLanguage = (def) => {
    locale.languages.push(def.id)
    locale.definition = def
    return () => (locale.languages = locale.languages.filter((id) => id !== def.id))
  }
  locale.register = (ns, id, dict) => {
    locale.dicts.push({ ns, id, dict })
    return () => {}
  }
  locale.getSnapshot = () => ({ active: locale.active })
  locale.setLocale = (id) => {
    if (!locale.languages.includes(id)) throw new Error(`unknown locale ${id}`)
    locale.active = id
    for (const fn of [...locale.listeners]) fn()
  }
  locale.subscribe = (fn) => {
    locale.listeners.add(fn)
    return () => locale.listeners.delete(fn)
  }
  const styles = []
  const link = { href: "favicon.svg" }
  const document = {
    title: "DeepSeek Harness",
    documentElement: { dataset: {} },
    head: { appendChild: (tag) => styles.push(tag) },
    querySelectorAll: () => [link],
    createElement: () => ({ dataset: {}, remove() {} }),
  }
  const observed = []
  class MutationObserver {
    constructor(callback) {
      this.callback = callback
      observed.push(this)
    }
    observe() {}
    disconnect() {}
  }
  const jsx = (type, props) => ({ type, props })
  const react = { useState: (init) => [typeof init === "function" ? init() : init, () => {}], useEffect: () => {} }
  const context = {
    window: { __ModuleLoader__: { load: (spec) => (loaded = spec) } },
    document,
    MutationObserver,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
  }
  vm.runInNewContext(readFileSync(join(ROOT, "plugins", "brand", "client.js"), "utf8"), context)
  const exports = loaded.factory((name) => (name === "react" ? react : { jsx, jsxs: jsx }))
  const effects = []
  exports.apply({ slots, theme, locale, effect: (fn, label) => effects.push({ label, dispose: fn() }) })
  return { loaded, exports, slots, theme, locale, styles, document, link, observed, effects }
}

test("the browser half registers the theme layer, the brand slots and its styles", () => {
  const { loaded, exports, slots, theme, styles, document, link, observed, effects } = loadClient()
  assert.equal(loaded.id, "@kriya-ai/harness-brand")
  // Copied: arrays from the vm's own realm
  assert.deepEqual([...exports.inject], ["slots", "theme", "locale"])
  assert.deepEqual(
    slots.registered.map((r) => r.name).sort(),
    ["conversation.hero.brand.mark", "sidebar.brand.mark", "sidebar.brand.name"]
  )
  const mark = slots.registered.find((r) => r.name === "sidebar.brand.mark").component({ size: 24 })
  assert.equal(mark.props["aria-label"], "Kriya")
  assert.equal(mark.props.width, 24)

  assert.equal(theme.layers.length, 1)
  assert.equal(theme.layers[0].source, "@kriya-ai/harness-brand")
  for (const [name, value] of Object.entries(theme.layers[0].tokens)) {
    assert.match(name, /^--/, name)
    assert.equal(typeof value.light, "string", name)
    assert.equal(typeof value.dark, "string", name)
  }
  assert.ok(styles.some((tag) => tag.textContent.includes(".kh-hero")))
  // The material is on while the styles are, and off with them
  assert.equal(document.documentElement.dataset.khGlass, "")
  effects.find((e) => e.label === "kriya: styles and fonts").dispose()
  assert.equal(document.documentElement.dataset.khGlass, undefined)

  assert.match(link.href, /^data:image\/svg\+xml,/)
  assert.equal(document.title, "Kriya Harness")
  document.title = "Fix the tests — DeepSeek Harness"
  observed[0].callback()
  assert.equal(document.title, "Fix the tests — Kriya Harness")
  assert.equal(exports.kriyaTitle("About DeepSeek Harness — Kriya Harness"), "About DeepSeek Harness — Kriya Harness")
})

test("the start screen asks a plain question and says what's true", () => {
  const { slots } = loadClient()
  const hero = slots.registered.find((r) => r.name === "conversation.hero.brand.mark").component({})
  const text = JSON.stringify(hero)
  assert.match(text, /What are we working on\?/)
  assert.match(text, /Runs in this folder on your computer\. Model use counts toward your Kriya plan\./)
  assert.doesNotMatch(text, /DeepSeek/)
})

test("Kriya Harness speaks one language, Kriya's English, and keeps to it", () => {
  const { locale, exports } = loadClient()
  assert.equal(locale.definition.id, "en-IN")
  assert.equal(locale.definition.fallback, "en")
  // Picked at once, over a stored or browser-derived 中文
  assert.equal(locale.active, "en-IN")
  // The Host's stored preference arriving later is switched back
  locale.setLocale("zh")
  assert.equal(locale.active, "en-IN")
  locale.setLocale("en")
  assert.equal(locale.active, "en-IN")
  // Every override is for Kriya's language, and none names DSH or DeepSeek
  assert.ok(locale.dicts.length >= 5)
  for (const { ns, id, dict } of locale.dicts) {
    assert.equal(id, "en-IN", ns)
    for (const [key, text] of Object.entries(dict)) assert.doesNotMatch(text, /\b(DSH|DeepSeek)\b/, `${ns}.${key}`)
  }
  assert.deepEqual(Object.keys(exports.COPY).sort(), locale.dicts.map((d) => d.ns).sort())
  // With one language there's nothing to choose: DSH's Language row is hidden
  assert.match(exports.CSS, /\.hVGvvW_row \{ display: none; \}/)
})

// Each overridden key must still be one DSH's English has, in the same
// namespace; a DSH bump that renames one fails here, not on screen
test("every key Kriya's English overrides exists in the pinned DSH's English", () => {
  const { exports } = loadClient()
  const scope = join(require.resolve("@deepseek-ai/dsh/package.json"), "..", "..")
  const dsh = readdirSync(scope)
    .map((name) => join(scope, name, "lib", "client.js"))
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n")
  for (const [ns, dict] of Object.entries(exports.COPY))
    for (const key of Object.keys(dict))
      assert.ok(dsh.includes(`"${key}":`) || dsh.includes(`\t${key}:`) || dsh.includes(` ${key}:`), `${ns}.${key} is gone from the pinned DSH`)
})

// WCAG contrast of the theme's text tokens on its surfaces (DESIGN.md rules)
const luminance = (hex) => {
  const [r, g, b] = hex
    .slice(1)
    .match(/../g)
    .map((h) => parseInt(h, 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

test("text contrast: body at least 7:1, secondary and action text at least 4.5:1, in both schemes", () => {
  const { exports } = loadClient()
  const T = exports.TOKENS
  const surfaces = ["--dsw-alias-bg-base", "--dsw-alias-bg-layer-1", "--dsw-specific-sidebar-fill"]
  const rules = [
    ["--dsw-alias-label-primary", 7],
    ["--dsw-alias-label-secondary", 4.5],
    ["--dsw-alias-label-tertiary", 4.5],
    ["--dsw-alias-link", 4.5],
    ["--dsw-alias-state-warn-label", 4.5],
    ["--dsw-alias-label-deep-diving", 4.5],
    // Captions are incidental text (timestamps); still kept readable
    ["--dsw-alias-label-caption", 3],
  ]
  for (const [scheme, i] of [["light", 0], ["dark", 1]])
    for (const surface of surfaces)
      for (const [label, min] of rules) {
        const ratio = contrast(T[label][i], T[surface][i])
        assert.ok(ratio >= min, `${label} on ${surface} (${scheme}): ${ratio.toFixed(2)} < ${min}`)
      }
  // Text on the primary button
  assert.ok(contrast(T["--dsw-alias-label-primary-foreground"][0], T["--dsw-alias-button-primary-fill"][0]) >= 7)
  assert.ok(contrast(T["--dsw-alias-label-primary-foreground"][1], T["--dsw-alias-button-primary-fill"][1]) >= 7)
})

// Text on glass: a pane's tint laid over the ground it floats on (paper,
// and paper under each of the ground's two lights)
const over = (tint, hex) => {
  const [r, g, b, a] = tint.match(/^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/).slice(1).map(Number)
  const base = hex.slice(1).match(/../g).map((h) => parseInt(h, 16))
  return "#" + [r, g, b].map((c, i) => Math.round(c * a + base[i] * (1 - a)).toString(16).padStart(2, "0")).join("")
}

test("text contrast holds on every glass pane, over every part of the ground, in both schemes", () => {
  const T = loadClient().exports.TOKENS
  const rules = [
    ["--dsw-alias-label-primary", 7],
    ["--dsw-alias-label-secondary", 4.5],
    ["--dsw-alias-label-tertiary", 4.5],
    ["--dsw-alias-link", 4.5],
  ]
  for (const [scheme, i] of [["light", 0], ["dark", 1]]) {
    const paper = T["--dsw-alias-bg-base"][i]
    const grounds = [paper, over(T["--kh-ground-a"][i], paper), over(T["--kh-ground-b"][i], paper)]
    for (const pane of ["--kh-glass", "--kh-glass-thick", "--dsw-specific-menu"])
      for (const ground of grounds)
        for (const [label, min] of rules) {
          const ratio = contrast(T[label][i], over(T[pane][i], ground))
          assert.ok(ratio >= min, `${label} on ${pane} over ${ground} (${scheme}): ${ratio.toFixed(2)} < ${min}`)
        }
  }
})

test("panes turn solid where transparency is reduced or glass can't be drawn", () => {
  const { CSS } = loadClient().exports
  assert.match(CSS, /@media \(prefers-reduced-transparency: reduce\)[^@]*--kh-blur: none !important/)
  assert.match(CSS, /@supports not \(\(backdrop-filter: blur\(1px\)\)[^@]*--kh-glass: var\(--dsw-alias-bg-layer-1\) !important/)
})

// The material styles DSH's own elements by their (hashed) class names;
// each must still exist in the pinned DSH
test("every DSH class the material styles exists in the pinned DSH", () => {
  const { CSS } = loadClient().exports
  const scope = join(require.resolve("@deepseek-ai/dsh/package.json"), "..", "..")
  const dsh = readdirSync(scope)
    .map((name) => join(scope, name, "lib", "client.js"))
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n")
  const classes = new Set([...CSS.matchAll(/\.([A-Za-z0-9-]{6}_[A-Za-z][A-Za-z0-9]*)/g)].map((m) => m[1]))
  assert.ok(classes.size >= 20, `found ${classes.size} DSH classes`)
  for (const name of classes) assert.ok(dsh.includes(name), `${name} is gone from the pinned DSH`)
})

// What the theme relies on in the pinned DSH; a bump that moves any of
// these fails here before anyone sees a broken screen
test("pinned DSH still has the structures the theme relies on", () => {
  const conversation = dshClient("dsh-client-ui-conversation")
  const hitbox = conversation.indexOf("HeroShell_module_css_default.fishHitbox")
  const slot = conversation.indexOf('renderSlot("conversation.hero.brand.mark"', hitbox)
  const title = conversation.indexOf("HeroShell_module_css_default.titleGroup", slot)
  assert.ok(hitbox > 0 && slot > hitbox && title > slot, "hero: mark slot inside a span followed by the title group")
  assert.match(dshClient("dsh-client-ui-layout"), /const productTitle = "DeepSeek Harness"/)
  const sidebar = dshClient("dsh-client-ui-sidebar")
  assert.match(sidebar, /renderSlot\("sidebar\.brand\.mark"/)
  assert.match(sidebar, /renderSlot\("sidebar\.brand\.name"/)
  assert.match(dshClient("dsh-client-ui-theme"), /overrideTokens\(source, tokens\)/)
  assert.match(dshClient("dsh-client-ui-settings-models"), /WELCOME_NOTICE_VERSION = "2026-09-28\.1"/)
})
