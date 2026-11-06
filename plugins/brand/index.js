// Kriya brand plugin, node half. The browser half (client.js) fills DeepSeek
// Harness's brand slots, as its dsh-client-ui-brand-official README asks of
// "deployments with another identity". Here, the page itself says Kriya
// Harness before any script runs (owner, 2026-11-06): the served index.html's
// title, through the web server's documented
// `tapIndex` transform. Profiles without the web server skip it.

/** The index page's title as Kriya Harness */
export const kriyaIndex = (html) => html.replace(/<title>[^<]*<\/title>/i, "<title>Kriya Harness</title>")

export function apply(ctx) {
  ctx.inject(["webServer"], (web) => {
    web.effect(() => web.webServer.tapIndex(kriyaIndex))
  })
}
