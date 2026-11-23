import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { CONTRACTS_DIR } from "../contracts.js"
import { kriyaHome } from "../paths.js"
import { readStack } from "../stack.js"
import { keepShot, SCHEMES, VIEWPORTS, withGateBrowser } from "./page.js"

// Harness 2.0 W4: G-UI and G-A11Y (Kriya-Tavi docs/kriya-harness/upgrade_2.0/
// GATES.md §3). Both read the same rendered pages, so they share one visit per
// route × viewport × scheme, made once per verify. The app is the one the
// person confirmed with `kriya stack use --app`; routes are "/" plus the
// component previews named in .kriya/contracts/component_states.json.

export const MAX_ROUTES = 4
export const CLS_LIMIT = 0.1
export const TARGET_MIN = 24
export const TARGET_WARN = 44

/** The routes to render: "/" and each component preview (contract, hash-locked by its owner), at most MAX_ROUTES. */
export function uiRoutes(root) {
  const routes = ["/"]
  const file = join(root, CONTRACTS_DIR, "component_states.json")
  if (existsSync(file)) {
    try {
      for (const c of Object.values(JSON.parse(readFileSync(file, "utf8")))) if (typeof c?.preview === "string" && /^\/\S*$/.test(c.preview) && !routes.includes(c.preview)) routes.push(c.preview)
    } catch {
      // G-CONTRACT reports a broken contract
    }
  }
  return routes.slice(0, MAX_ROUTES)
}

const evidenceDir = (root, label) =>
  join(kriyaHome(), "evidence", createHash("sha256").update(root).digest("hex").slice(0, 16), String(label).replace(/[^\w.-]+/g, "-").slice(0, 60), new Date().toISOString().replace(/[:.]/g, "-"))

/**
 * Every page report for this verify, or { skip: reason }. Made once and shared by G-UI and G-A11Y.
 * @param {{ root: string, label: string, launch?: () => Promise<any> }} input
 */
export async function uiReports({ root, label, launch, app: given }) {
  // Harness 2.0 W17: G-RELEASE points the same visits at the production server it was given
  const app = given ?? readStack(root).app
  if (!app) return { skip: "no app is confirmed for this project (kriya stack use --app http://localhost:<port>)", optional: true }
  const routes = uiRoutes(root)
  const dir = evidenceDir(root, label)
  const visited = await withGateBrowser(
    async (open) => {
      const reports = []
      for (const route of routes)
        for (const viewport of VIEWPORTS)
          for (const scheme of SCHEMES) {
            const report = await open(new URL(route, app).href, { viewport, scheme })
            if (report.unreachable) return { unreachable: `${app} doesn't answer (${report.unreachable}); start the app, or confirm another with kriya stack use --app` }
            const sha = keepShot(dir, `${route.replace(/\W+/g, "_") || "root"}-${viewport.name}-${scheme}.png`, report.shot)
            delete report.shot
            reports.push({ route, ...report, ...(sha && { evidence: sha }) })
          }
      return { reports }
    },
    { launch }
  )
  if (visited.unavailable) return { skip: visited.unavailable }
  if (visited.value.unreachable) return { skip: visited.value.unreachable }
  return { reports: visited.value.reports, dir }
}

const at = (r) => `${r.route} at ${r.viewport}px ${r.scheme}`
const lines = (items, n = 12) => items.slice(0, n).map((x) => `- ${x}`).join("\n") + (items.length > n ? `\n- … and ${items.length - n} more` : "")

/** G-UI over the shared reports */
export function judgeUi(ui) {
  if (ui.skip) return { id: "G-UI", status: "not_checked", reason: ui.skip, ...(ui.optional && { optional: true }) }
  const problems = []
  const warnings = []
  for (const r of ui.reports) {
    for (const e of r.consoleErrors) problems.push(`${at(r)}: console error: ${e}`)
    for (const f of r.failed) problems.push(`${at(r)}: request ${f}`)
    if (r.status !== null && r.status >= 400) problems.push(`${at(r)}: the page answered ${r.status}`)
    if (r.overflow) problems.push(`${at(r)}: the page scrolls sideways (content wider than the screen)`)
    if (r.cls > CLS_LIMIT) problems.push(`${at(r)}: layout shift ${r.cls} (over ${CLS_LIMIT})`)
    if (Number(r.viewport) < 768) {
      for (const s of r.small) {
        if (Math.min(...s.size) < TARGET_MIN) problems.push(`${at(r)}: ${s.what} is ${s.size.join("×")} px, under the ${TARGET_MIN} px minimum to tap`)
        else if (Math.min(...s.size) < TARGET_WARN) warnings.push(`${at(r)}: ${s.what} is ${s.size.join("×")} px; ${TARGET_WARN} px is easier to tap`)
      }
    }
  }
  const unique = [...new Set(problems)]
  const evidence = ui.reports.map((r) => r.evidence).filter(Boolean)
  if (unique.length) return { id: "G-UI", status: "fail", kind: "gate", excerpt: `G-UI (rendered at ${VIEWPORTS.map((v) => v.name).join(", ")} px, light and dark):\n${lines(unique)}`, evidence }
  return { id: "G-UI", status: "pass", evidence, ...(warnings.length && { warnings: warnings.length, note: lines([...new Set(warnings)], 6) }) }
}

/** G-A11Y over the shared reports: names, language, contrast (plain and over glass), heading order as a warning */
export function judgeA11y(ui) {
  if (ui.skip) return { id: "G-A11Y", status: "not_checked", reason: ui.skip, ...(ui.optional && { optional: true }) }
  const problems = []
  const warnings = []
  for (const r of ui.reports) {
    if (!r.lang) problems.push(`${at(r)}: <html> has no lang`)
    for (const u of r.unnamed) problems.push(`${at(r)}: ${u} has no accessible name`)
    for (const c of r.lowContrast) problems.push(`${at(r)}: "${c.text}" (${c.what}) has contrast ${c.ratio}:1, needs ${c.need}:1`)
    for (const g of r.glass) if (g.worst < g.need) problems.push(`${at(r)}: text on a glass surface (${g.what}) reaches only ${Math.round(g.worst * 100) / 100}:1 over its backdrop, needs ${g.need}:1; make the surface more opaque or add a solid fallback`)
    if (r.headingSkips) warnings.push(`${at(r)}: heading levels skip ${r.headingSkips} time(s)`)
  }
  const unique = [...new Set(problems)]
  if (unique.length) return { id: "G-A11Y", status: "fail", kind: "gate", excerpt: `G-A11Y:\n${lines(unique)}` }
  return { id: "G-A11Y", status: "pass", ...(warnings.length && { warnings: warnings.length, note: lines([...new Set(warnings)], 6) }) }
}
