// `npm run build:studio`: bundles studio/src into studio/dist with esbuild. Only the
// Studio's own code goes in: it has no runtime dependency, so nothing third-party ships.

import { copyFileSync, mkdirSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = fileURLToPath(new URL(".", import.meta.url))
export const DIST = join(HERE, "dist")
// The harness's own faces (plugins/brand/DESIGN.md, scripts/build-brand.js): variable, Latin, OFL-1.1, already in THIRD_PARTY_NOTICES.md.
// Copied as files, never bundled code: the Host serves them from the Studio's own origin
export const FONTS = {
  "geist.woff2": "@fontsource-variable/geist/files/geist-latin-wght-normal.woff2",
  "fraunces.woff2": "@fontsource-variable/fraunces/files/fraunces-latin-full-normal.woff2",
  "jetbrains-mono.woff2": "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2",
}

export async function buildStudio() {
  const { build } = await import("esbuild")
  rmSync(DIST, { recursive: true, force: true })
  mkdirSync(DIST, { recursive: true })
  const result = await build({
    entryPoints: { studio: join(HERE, "src", "main.js") },
    bundle: true,
    format: "esm",
    target: "chrome120",
    minify: process.env.STUDIO_DEBUG !== "1",
    sourcemap: false,
    outdir: DIST,
    metafile: true,
    logLevel: "warning",
  })
  copyFileSync(join(HERE, "src", "styles.css"), join(DIST, "studio.css"))
  copyFileSync(join(HERE, "index.html"), join(DIST, "index.html"))
  const require = createRequire(join(HERE, "..", "package.json"))
  mkdirSync(join(DIST, "fonts"), { recursive: true })
  for (const [name, from] of Object.entries(FONTS)) copyFileSync(require.resolve(from), join(DIST, "fonts", name))
  const outside = Object.keys(result.metafile.inputs).filter((file) => !file.startsWith("studio/src/") && !file.includes("/studio/src/"))
  if (outside.length) throw new Error(`The Studio bundle took in code from outside studio/src: ${outside.join(", ")}`)
  return result
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildStudio()
  console.log(`build:studio: ${DIST}`)
}
