// `npm run build:studio`: bundles studio/src into studio/dist with esbuild. Only the
// Studio's own code goes in: it has no runtime dependency, so nothing third-party ships.

import { copyFileSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = fileURLToPath(new URL(".", import.meta.url))
export const DIST = join(HERE, "dist")

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
  const outside = Object.keys(result.metafile.inputs).filter((file) => !file.startsWith("studio/src/") && !file.includes("/studio/src/"))
  if (outside.length) throw new Error(`The Studio bundle took in code from outside studio/src: ${outside.join(", ")}`)
  return result
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildStudio()
  console.log(`build:studio: ${DIST}`)
}
