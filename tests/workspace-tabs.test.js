import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import vm from "node:vm"

import { ROOT } from "./helpers.js"

// The Web UI's Kriya tabs (Overview, Progress, Preview), browser halves,
// WP-TAB-*: each registers a right-sidebar tab and its body, and Preview
// frames loopback addresses only, never the Web UI's own port.

function load(plugin) {
  let loaded
  const react = { createElement: () => ({}), Fragment: "f", useState: (v) => [typeof v === "function" ? v() : v, () => {}], useEffect: () => {}, useCallback: (f) => f, useRef: () => ({}) }
  const context = { window: { __ModuleLoader__: { load: (spec) => (loaded = spec) } }, URL, URLSearchParams }
  vm.runInNewContext(readFileSync(join(ROOT, "plugins", plugin, "client.js"), "utf8"), context)
  return { loaded, exports: loaded.factory((name) => (name === "react" ? react : assert.fail(`unexpected require ${name}`))) }
}

test("WP-TAB-01: each tab registers its type and its body in the right sidebar", () => {
  for (const [plugin, title] of [
    ["overview", "Overview"],
    ["progress", "Progress"],
    ["preview", "Preview"],
  ]) {
    const { loaded, exports } = load(plugin)
    assert.equal(loaded.id, `@kriya-ai/harness-${plugin}`)
    assert.deepEqual([...exports.inject], ["slots", "sidebarRightTabs"])
    assert.equal(exports.definition.title(), title)
    const registered = []
    const bodies = []
    exports.apply({
      sidebarRightTabs: { register: (d) => (registered.push(d), () => {}) },
      slots: { inject: (name, fn) => (bodies.push(name), fn()), register: (spec, body) => (bodies.push(spec.key), body) },
      effect: (fn) => fn(),
    })
    assert.equal(registered[0], exports.definition)
    assert.deepEqual(bodies, ["sidebar.right.pane.tab", `@kriya-ai/harness-${plugin}`])
  }
})

test("WP-TAB-02: Preview frames loopback http(s) only, never the Web UI's own port", () => {
  const { previewUrl } = load("preview").exports
  const self = new URL("http://127.0.0.1:6796/?token=x")
  for (const [input, url] of [
    ["localhost:3000", "http://localhost:3000/"],
    ["3000", "http://localhost:3000/"],
    ["http://127.0.0.1:5173/app", "http://127.0.0.1:5173/app"],
    ["https://app.localhost:8443", "https://app.localhost:8443/"],
    ["http://[::1]:4000", "http://[::1]:4000/"],
  ])
    assert.equal(previewUrl(input, self).url, url, input)
  for (const [input, why] of [
    ["https://github.com", /this computer only/],
    ["http://192.168.1.5:3000", /this computer only/],
    ["http://localhost.evil.com:3000", /this computer only/],
    ["http://127.0.0.1:6796", /Kriya Harness itself/],
    ["localhost:6796", /Kriya Harness itself/],
    ["file:///etc/passwd", /Only http/],
    ["javascript:alert(1)", /Only http|isn.t an address/],
    ["http://user:pw@localhost:3000", /user name or password/],
    ["", /Type a local address/],
  ])
    assert.match(previewUrl(input, self).error ?? "", why, input)
})
