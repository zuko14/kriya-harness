import assert from "node:assert/strict"
import { createServer } from "node:http"
import { test } from "node:test"
import { gunzipSync } from "node:zlib"

import { blockedAnswer, encodeBody, firewallBlock, MAX_BODY, startGatewayProxy } from "../src/gateway-proxy.js"
import { FIREWALL_PAGE } from "./fake-kriya.js"

// The local relay (src/gateway-proxy.js; owner decision 2026-11-04,
// "Encode bodies"): JSON bodies go gzip+base64 when Kriya reads them, the
// host firewall's block page becomes a plain 400, answers stream through.

const RISKY = "rm -rf /tmp/x; <script>alert(1)</script> ' OR 1=1 -- ../../etc/passwd"

/** A fake upstream recording what arrives; `answer` decides the reply */
async function upstream(answer) {
  const seen = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const record = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) }
    seen.push(record)
    await answer(record, res)
  })
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) }
}

const json = (res, status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body))

test("JSON bodies go gzip+base64 when Kriya reads them; the decoded body is the original, byte for byte", async () => {
  const up = await upstream((_r, res) => json(res, 200, { ok: true }))
  const relay = await startGatewayProxy({ target: up.url, encode: true })
  const body = JSON.stringify({ model: "budget", messages: [{ role: "user", content: RISKY.repeat(50) }] })
  const res = await fetch(`${relay.url}/api/harness/v1/chat/completions?x=1`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer dev-token", "x-kriya-harness": "0.2.0" },
    body,
  })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true })
  const [got] = up.seen
  assert.equal(got.url, "/api/harness/v1/chat/completions?x=1")
  assert.equal(got.headers["x-kriya-body"], "gzip+base64")
  assert.match(got.headers["content-type"], /^text\/plain/)
  assert.equal(got.headers.authorization, "Bearer dev-token", "the token DSH sent, unchanged")
  assert.equal(got.headers["x-kriya-harness"], "0.2.0")
  const text = got.body.toString("ascii")
  assert.match(text, /^[A-Za-z0-9+/]+=*$/, "only base64 characters reach the host")
  assert.ok(text.length < body.length, "smaller than the original")
  assert.equal(gunzipSync(Buffer.from(text, "base64")).toString("utf8"), body)
  await relay.close()
  await up.close()
})

test("without Kriya's support, and for GET and multipart, bodies go unchanged", async () => {
  const up = await upstream((_r, res) => json(res, 200, { ok: true }))
  const off = await startGatewayProxy({ target: up.url, encode: false })
  const body = JSON.stringify({ content: RISKY })
  await fetch(`${off.url}/api/harness/v1/memory`, { method: "POST", headers: { "content-type": "application/json" }, body })
  assert.equal(up.seen[0].headers["x-kriya-body"], undefined)
  assert.equal(up.seen[0].body.toString(), body)
  const on = await startGatewayProxy({ target: up.url, encode: true })
  await fetch(`${on.url}/api/harness/v1/models`)
  assert.equal(up.seen[1].method, "GET")
  assert.equal(up.seen[1].body.length, 0)
  const form = new FormData()
  form.set("meta", "{}")
  await fetch(`${on.url}/api/harness/v1/handoff`, { method: "POST", body: form })
  assert.match(up.seen[2].headers["content-type"], /^multipart\/form-data/)
  assert.equal(up.seen[2].headers["x-kriya-body"], undefined)
  await off.close()
  await on.close()
  await up.close()
})

test("the firewall's block page becomes a 400 that names it and the request ID, never a 401/403", async () => {
  const up = await upstream((_r, res) => res.writeHead(403, { "content-type": "text/html" }).end(FIREWALL_PAGE))
  const logs = []
  const relay = await startGatewayProxy({ target: up.url, encode: true, log: (t) => logs.push(t) })
  const res = await fetch(`${relay.url}/api/harness/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
  assert.equal(res.status, 400)
  const answer = await res.json()
  assert.equal(answer.error.code, "blocked_by_host")
  assert.match(answer.error.message, /host firewall blocked this request \(request ID a553e7b17903d5ee\)/)
  assert.match(answer.error.message, /sign-in is fine/)
  assert.doesNotMatch(answer.error.message, /\b40[13]\b/, "DSH reads 401/403 in the text as a bad API key")
  assert.match(logs[0], /firewall blocked POST \/api\/harness\/v1\/chat\/completions \(request ID a553e7b17903d5ee\)/)
  // Another HTML 403 (not the firewall) is an outage-like 502; Kriya's own JSON 403 passes through
  assert.equal(firewallBlock(403, "text/html", "<html>Forbidden</html>"), null)
  assert.equal(firewallBlock(403, "application/json", FIREWALL_PAGE), null)
  assert.deepEqual(firewallBlock(403, "text/html; charset=utf-8", FIREWALL_PAGE), { requestId: "a553e7b17903d5ee" })
  assert.match(JSON.parse(blockedAnswer(null)).error.message, /blocked this request\. Your sign-in/)
  await relay.close()
  await up.close()
})

test("Kriya's own answers pass through: JSON errors with their status, and a stream chunk by chunk", async () => {
  let n = 0
  const up = await upstream((_r, res) => {
    n += 1
    if (n === 1) return json(res, 403, { error: "suspended", message: "This Kriya account is paused." })
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write("data: one\n\n")
    setTimeout(() => res.end("data: [DONE]\n\n"), 20)
  })
  const relay = await startGatewayProxy({ target: up.url, encode: true })
  const refused = await fetch(`${relay.url}/api/harness/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
  assert.equal(refused.status, 403)
  assert.deepEqual(await refused.json(), { error: "suspended", message: "This Kriya account is paused." })
  const streamed = await fetch(`${relay.url}/api/harness/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
  assert.equal(streamed.headers.get("content-type"), "text/event-stream")
  assert.equal(await streamed.text(), "data: one\n\ndata: [DONE]\n\n")
  await relay.close()
  await up.close()
})

test("only the harness API's path is relayed, only to the signed-in Kriya; an unreachable Kriya is a 502", async () => {
  const up = await upstream((_r, res) => json(res, 200, {}))
  const relay = await startGatewayProxy({ target: `${up.url}/ignored/path`, encode: true })
  for (const path of ["/", "/api/other", "/api/harness/v10", "/../api/harness/v1/x"]) {
    const res = await fetch(`${relay.url}${path}`)
    if (path.startsWith("/../")) continue // fetch normalises it into the harness path
    assert.equal(res.status, 404, path)
  }
  assert.ok(relay.url.startsWith("http://127.0.0.1:"), "loopback only")
  assert.ok(up.seen.every((r) => r.url.startsWith("/api/harness/v1")))
  await up.close()
  const down = await fetch(`${relay.url}/api/harness/v1/models`)
  assert.equal(down.status, 502)
  assert.match((await down.json()).error.message, /Couldn't reach Kriya/)
  await relay.close()
  assert.ok(MAX_BODY >= 32 * 1024 * 1024)
  assert.equal(gunzipSync(Buffer.from(encodeBody(Buffer.from("{}")).toString(), "base64")).toString(), "{}")
})
