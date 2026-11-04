import { defineTool } from "@deepseek-ai/dsh-tools"

import { BrowserError, LocalBrowser, chromeInstalled } from "../../src/browser.js"

// The agent's localhost browser (browser stage 2), node half: the tools an
// agent tests and reviews a local app with, and the routes the Preview
// tab's "Agent's browser" view reads and drives, all on one shared
// LocalBrowser (src/browser.js): the installed Chrome, headless, loopback
// pages only. Off unless kriya was started with --browser-tools (KRIYA_BROWSER=on,
// the bundle row's switch): off, no tool, route or Chrome exists.
//
// Reading tools change nothing. browser_click, browser_type and
// browser_press act on the person's own local app, like a shell command in
// the workspace; in Read only they are refused. They never reach another
// site, type a password or pay: the engine opens loopback addresses only.

export const name = "kriya-browser"
// connection is optional: headless runs (kriya run) have the tools, not the view
export const inject = ["tools", "systemPrompt"]

export const ROUTES = { state: "/api/kriya.browser.state", frame: "/api/kriya.browser.frame", input: "/api/kriya.browser.input" }

export const GUIDANCE =
  "You have a browser for apps running on this computer (localhost only). To test or review a web app you are building: " +
  "start its dev server (in the background), then browser_open its local address, browser_read for its text and elements, " +
  "browser_screenshot to see it, browser_click / browser_type / browser_press with refs from browser_read, and " +
  "browser_console / browser_network for errors and failed requests. Check the page after each change; report what you saw, " +
  "not what you expect. Use these tools to look at and use the app, not a Playwright, Puppeteer or headless-Chrome script of " +
  "your own: the person watches these live in the Preview tab, and a script's browser is invisible to them. Write automated " +
  "browser tests only when the task asks for them, and run them with the project's own test command. " +
  "Other sites can't be opened. Never enter passwords, codes or payment details."

const text = (value) => [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }]
const OBJECT = { schema: { type: "object", additionalProperties: true, properties: {} } }

/**
 * The tools, on one browser. `readOnly(exec)` refuses acting tools in Read only;
 * `image(exec, jpeg)` returns an image block when the model takes images.
 * @param {{ browser: LocalBrowser, readOnly: (exec: any) => boolean, image: (exec: any, data: Buffer) => Promise<any | undefined> }} host
 */
export function tools(host) {
  const { browser } = host
  const acting = (exec) => {
    if (host.readOnly(exec)) throw new BrowserError("Read only: the browser can open and read pages, not click or type.")
  }
  return [
    defineTool({
      name: "browser_open",
      description: "Open an app running on this computer in the agent's browser: a local address such as localhost:3000 or http://127.0.0.1:5173/path. Other sites can't be opened.",
      parameters: { url: { type: "string", required: true, description: "The local address, e.g. localhost:3000." } },
      output: { ...OBJECT, render: (_a, v) => text(`Opened ${v.url} (${v.status ?? "no status"}): ${v.title || "untitled"}`) },
      execute: (args) => browser.open(args.url),
      presentCall: (args) => ({ card: "generic", title: "Open in browser", kind: "read", rawInput: String(args.url ?? "") }),
    }),
    defineTool({
      name: "browser_read",
      description: "The open page's address, title, visible text and its interactive elements, each with a ref (e1, e2, …) for browser_click and browser_type.",
      parameters: {},
      output: {
        ...OBJECT,
        render: (_a, v) => text(`${v.title} — ${v.url}\n\nElements:\n${v.elements.map((e) => `${e.ref} ${e.role}${e.type ? `[${e.type}]` : ""} ${JSON.stringify(e.name)}`).join("\n") || "(none)"}\n\nText:\n${v.text}`),
      },
      execute: () => browser.read(),
      presentCall: () => ({ card: "generic", title: "Read the page", kind: "read", rawInput: "" }),
    }),
    defineTool({
      name: "browser_screenshot",
      description: "A screenshot of the open page, to see layout and visual state.",
      parameters: {},
      output: {
        ...OBJECT,
        render: (_a, v) => (v.image ? [{ type: "text", text: `Screenshot of ${v.url} (1280×800)` }, { type: "image", attachment: v.image }] : text(v.note)),
      },
      async execute(_args, exec) {
        const shot = await browser.screenshot()
        const image = await host.image(exec, Buffer.from(shot.data, "base64"))
        return image ? { url: shot.url, image } : { url: shot.url, note: "This model can't take images; use browser_read for the page's text and elements. The person sees the page in the Preview tab." }
      },
      presentCall: () => ({ card: "generic", title: "Screenshot", kind: "read", rawInput: "" }),
    }),
    defineTool({
      name: "browser_click",
      description: "Click an element of the open page by its ref from browser_read. A link out of localhost is refused and the page stays.",
      parameters: { ref: { type: "string", required: true, description: "An element ref from browser_read, e.g. e3." } },
      output: { ...OBJECT, render: (_a, v) => text(`Clicked. Now on ${v.url}: ${v.title || "untitled"}${v.refused ? `. Refused (not local): ${v.refused.join(", ")}` : ""}. Call browser_read to see the result.`) },
      execute(args, exec) {
        acting(exec)
        return browser.click(args.ref)
      },
      presentCall: (args) => ({ card: "generic", title: "Click", kind: "execute", rawInput: String(args.ref ?? "") }),
    }),
    defineTool({
      name: "browser_type",
      description: "Replace the text in an input, textarea or editable element of the open page (ref from browser_read). Never passwords, codes or payment details.",
      parameters: { ref: { type: "string", required: true, description: "An element ref from browser_read." }, text: { type: "string", required: true, description: "The text to put in it." } },
      output: { ...OBJECT, render: (_a, v) => text(`Typed ${v.typed} characters.`) },
      execute(args, exec) {
        acting(exec)
        return browser.type(args.ref, args.text)
      },
      presentCall: (args) => ({ card: "generic", title: "Type", kind: "execute", rawInput: String(args.ref ?? "") }),
    }),
    defineTool({
      name: "browser_press",
      description: "Press a key on the open page, e.g. Enter, Tab, Escape, ArrowDown.",
      parameters: { key: { type: "string", required: true, description: "The key's name." } },
      output: { ...OBJECT, render: (_a, v) => text(`Pressed ${v.pressed}. Now on ${v.url}${v.refused ? `. Refused (not local): ${v.refused.join(", ")}` : ""}.`) },
      execute(args, exec) {
        acting(exec)
        return browser.press(args.key)
      },
      presentCall: (args) => ({ card: "generic", title: "Press a key", kind: "execute", rawInput: String(args.key ?? "") }),
    }),
    defineTool({
      name: "browser_console",
      description: "The open page's console messages and uncaught errors, and any navigations the browser refused, newest last.",
      parameters: {},
      output: { ...OBJECT, render: (_a, v) => text([...v.console.map((m) => `[${m.type}] ${m.text}`), ...v.blocked.map((b) => `[refused] ${b.url}`)].join("\n") || "No console messages.") },
      execute: () => browser.logs(),
      presentCall: () => ({ card: "generic", title: "Console", kind: "read", rawInput: "" }),
    }),
    defineTool({
      name: "browser_network",
      description: "The open page's requests: method, address, status (failed requests have none), newest last.",
      parameters: {},
      output: { schema: { type: "array", items: { type: "object", additionalProperties: true, properties: {} } }, render: (_a, v) => text(v.map((r) => `${r.method} ${r.status ?? `failed (${r.failure ?? "?"})`} ${r.url}`).join("\n") || "No requests.") },
      execute: () => browser.requests(),
      presentCall: () => ({ card: "generic", title: "Network", kind: "read", rawInput: "" }),
    }),
  ]
}

const json = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } })

/** The Preview tab's routes: where the browser is, its latest frame, and the person's input */
export function routes(browser) {
  return {
    [ROUTES.state]: async () => json({ enabled: true, url: browser.current && !browser.current.isClosed() ? browser.current.url() : null }),
    [ROUTES.frame]: async () => {
      const frame = await browser.frame()
      if (!frame) return new Response(null, { status: 204, headers: { "cache-control": "no-store" } })
      return new Response(frame.data, { headers: { "content-type": "image/jpeg", "cache-control": "no-store", "x-kriya-url": encodeURI(frame.url) } })
    },
    [ROUTES.input]: async (request) => {
      let body
      try {
        body = JSON.parse(await request.text())
      } catch {
        return json({ error: "A JSON body is needed." }, 400)
      }
      try {
        if (body?.kind === "open") return json(await browser.open(body.url))
        if (body?.kind === "click" || body?.kind === "wheel") return json(await browser.pointer({ x: Number(body.x), y: Number(body.y), kind: body.kind, deltaY: body.deltaY }))
        if (body?.kind === "key") return json(await browser.press(body.key))
        if (body?.kind === "text") {
          if (typeof body.text !== "string" || body.text.length > 500) return json({ error: "Text is at most 500 characters." }, 400)
          const page = await browser.requireOpen()
          await page.keyboard.type(body.text)
          return json({ typed: body.text.length })
        }
        return json({ error: "Unknown input." }, 400)
      } catch (error) {
        if (error instanceof BrowserError) return json({ error: error.message }, 400)
        throw error
      }
    },
  }
}

export function apply(ctx) {
  // No Chrome, no browser: neither tools nor guidance, so the agent isn't offered what can't start
  if (!chromeInstalled()) {
    ctx.logger("kriya-browser").info("Google Chrome isn't installed, so the agent's browser is off")
    return
  }
  const sandboxPolicy = ctx.get("sandboxPolicy")
  const browser = new LocalBrowser({ selfPort: () => ctx.get("webServer")?.port })
  ctx.effect(() => () => browser.close())
  const host = {
    browser,
    readOnly: (exec) => sandboxPolicy?.resolve({ session: exec.agent?.session })?.mode === "read-only",
    // An image block only when the session's model takes images (as DSH's read_image)
    async image(exec, data) {
      const attachments = ctx.get("attachments")
      const llm = ctx.get("llm")
      const routed = exec.agent?.session.requestHeader()?.config
      const provider = routed?.provider ?? exec.agent?.options.provider
      const model = routed?.model ?? exec.agent?.options.model
      if (!attachments || !llm || !provider || !model) return undefined
      const info = await llm.resolveModelInfo(provider, model, exec.signal).catch(() => undefined)
      if (!info?.inputModalities?.includes("image")) return undefined
      const ref = await attachments.saveImage({ data, mediaType: "image/jpeg", name: "browser.jpg" })
      return { attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height }
    },
  }
  for (const tool of tools(host)) ctx.tools.register(tool)
  const log = (error) => ctx.logger("kriya-browser").warn(error)
  // Only where the web server runs (not in headless kriya run): the view's routes
  ctx.inject(["connection"], (web) => {
    for (const [path, handler] of Object.entries(routes(browser)))
      web.effect(() =>
        web.connection.fetch.register({
          path,
          methods: path === ROUTES.input ? ["POST"] : ["GET"],
          requestBody: "buffered",
          fetch: async (request) => {
            try {
              return await handler(request)
            } catch (error) {
              log(error)
              return json({ error: "The browser couldn't do that; see the terminal for details." }, 500)
            }
          },
        })
      )
  })
  ctx.systemPrompt.section({ name: "tool:kriya_browser", order: ctx.systemPrompt.getSectionOrder("TOOL_BASH"), text: GUIDANCE })
}
