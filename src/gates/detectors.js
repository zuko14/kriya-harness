// Harness 2.0 W3: the fixed static detectors (Kriya-Tavi docs/kriya-harness/
// upgrade_2.0/CARTRIDGES.md §3–4, GATES.md G-DETECT). Each is plain code over
// one changed file: its path, its full text and the lines this work added.
// Findings point at added lines only, so code the project already had is
// never blamed. No detector runs anything, reads the network or takes a
// pattern from data: cartridges only name them by id, with a severity.
// Heuristic ones are warnings (feedback to the builder), never failures,
// unless a cartridge gives them severity "error".

const EXT = (re) => (path) => re.test(path)
const css = EXT(/\.(css|scss|sass|less)$/)
const ui = EXT(/\.(tsx|jsx|vue|svelte)$/)
const js = EXT(/\.(m?[jt]sx?|cjs)$/)
const py = EXT(/\.py$/)
const sql = EXT(/\.sql$/)
const tests = (path) => /(^|\/)(tests?|__tests__|spec|e2e)\//.test(path) || /\.(test|spec)\.[^/]+$/.test(path) || /(^|\/)test_[^/]+\.py$/.test(path)
const mobile = EXT(/\.(swift|kt|java|dart)$/)
const iac = EXT(/\.(tf|tfvars|json|ya?ml)$/)
const tokensFile = (path) => /(^|\/)(tokens|design-tokens|theme|globals|variables|colors?)\.[^/]+$/i.test(path)
const commentLine = (text) => /^\s*(\/\/|#|\*|\/\*|--|<!--)/.test(text)

/** Lines matching `re` among the added ones, as findings with `why`. */
const onAdded = (file, re, why, skip = commentLine) =>
  file.added.filter(({ text }) => !skip(text) && re.test(text)).map(({ line }) => ({ line, why }))

/** The 1-based line of a character offset. */
const lineAt = (content, index) => content.slice(0, index).split("\n").length

/** Matches of a multi-line pattern whose first line was added. */
function onAddedSpans(file, re, why, keep = () => true) {
  const added = new Set(file.added.map((a) => a.line))
  const out = []
  for (const m of file.content.matchAll(re)) {
    const line = lineAt(file.content, m.index)
    if (added.has(line) && keep(m)) out.push({ line, why })
  }
  return out
}

const shannon = (s) => {
  const counts = new Map()
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1)
  let h = 0
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length)
  return h
}

/** 1-based line numbers inside the blocks whose opening line matches `header` (the callback's body). */
function blockLines(content, header) {
  const lines = content.split("\n")
  const hot = new Set()
  for (let i = 0; i < lines.length; i++) {
    if (!header.test(lines[i]) || !lines[i].includes("{")) continue
    let depth = 0
    for (let j = i; j < lines.length; j++) {
      depth += (lines[j].match(/\{/g) ?? []).length - (lines[j].match(/\}/g) ?? []).length
      if (j > i) hot.add(j + 1)
      if (depth <= 0 && j > i) break
    }
  }
  return hot
}
const ANIMATION = /\b(function\s+(animate|render|tick|loop|frame)\b|(animate|render|tick|loop|frame)\s*=\s*(async\s*)?(\([^)]*\)|\w+)\s*=>|setAnimationLoop\s*\(|useFrame\s*\(|requestAnimationFrame\s*\()/
const GPU_RESOURCE = /\bnew\s+(THREE\.)?(\w*Geometry|\w*Material|\w*Texture|WebGLRenderTarget|WebGLRenderer)\s*\(|\bTextureLoader\s*\(\s*\)\s*\.load\s*\(/
const ASSET = /(^|\/)(assets|public|static|models|textures|hdri|media)\/.*\.(glb|gltf|hdr|exr|ktx2|png|jpe?g)$/i

/** Detector id → { files, find(file) }; `file` = { path, content, added: [{ line, text }] }. */
export const DETECTORS = {
  "FE-HEX": {
    files: (p) => (ui(p) || css(p)) && !tokensFile(p),
    find: (f) => onAdded(f, /(?<![\w&/])#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b(?![\w-])/, "a raw colour value; use a design token"),
  },
  "FE-PX": {
    files: (p) => (ui(p) || css(p)) && !tokensFile(p),
    find: (f) =>
      f.added
        .filter(({ text }) => !commentLine(text))
        .flatMap(({ line, text }) =>
          [...text.matchAll(/\b(margin|padding|gap|top|left|right|bottom|inset)[\w-]*\s*:\s*['"]?([^;'"}]*)/gi)].flatMap((m) =>
            [...m[2].matchAll(/(\d+)px/g)].filter((n) => Number(n[1]) > 2 && Number(n[1]) % 4 !== 0).map(() => ({ line, why: "spacing off the 4 px grid" }))
          )
        ),
  },
  "FE-IMG-ALT": {
    files: ui,
    find: (f) => onAddedSpans(f, /<img\b[^>]*>/g, "an image without alt", (m) => !/\balt\s*=/.test(m[0])),
  },
  "FE-CLICK-DIV": {
    files: ui,
    find: (f) => onAddedSpans(f, /<(div|span|li|td)\b[^>]*\bonClick\s*=[^>]*>/g, "a click handler on a non-interactive element without a role and a key handler", (m) => !(/\brole\s*=/.test(m[0]) && /\bonKey(Down|Up|Press)\s*=/.test(m[0]))),
  },
  "FE-FETCH-EFFECT": {
    files: (p) => ui(p) || js(p),
    find: (f) => (/useEffect\s*\(/.test(f.content) && !/AbortController|signal\s*:/.test(f.content) ? onAdded(f, /\bfetch\s*\(/, "a fetch in an effect that can't be cancelled") : []),
  },
  "FE-GLASS-CONTENT": {
    files: css,
    find: (f) => onAddedSpans(f, /([^{}]*)\{[^{}]*backdrop-filter[^{}]*\}/g, "glass behind content; keep it for controls and navigation", (m) => /\b(article|prose|content|post|paragraph|body-text)\b/i.test(m[1])),
  },
  "FE-GLASS-FALLBACK": {
    files: (p) => css(p) || ui(p),
    find: (f) => {
      if (!f.added.some(({ text }) => /backdrop-filter\s*:/.test(text))) return []
      const missing = [
        [/prefers-reduced-transparency/, "prefers-reduced-transparency"],
        [/prefers-contrast/, "prefers-contrast"],
        [/@supports\s+not\s*\(\s*(-webkit-)?backdrop-filter/, "@supports not (backdrop-filter)"],
      ].filter(([re]) => !re.test(f.content))
      if (!missing.length) return []
      const line = f.added.find(({ text }) => /backdrop-filter\s*:/.test(text)).line
      return [{ line, why: `glass without its solid fallbacks: ${missing.map(([, n]) => n).join(", ")}` }]
    },
  },
  "FE-TROPE": {
    files: (p) => ui(p) || /\.(html|md|mdx)$/.test(p),
    find: (f) => [
      ...onAdded(f, /\blorem ipsum\b/i, "placeholder text", () => false),
      ...onAdded(f, />\s*\p{Extended_Pictographic}\s*</u, "an emoji used as an icon", () => false),
    ],
  },
  "FE-FONT-LICENCE": {
    files: EXT(/\.(woff2?|ttf|otf)$/),
    find: (f) => (f.isNew && !f.siblings.some((n) => /^(OFL|LICEN[CS]E|COPYING)/i.test(n)) ? [{ line: 1, why: "a font file without its licence beside it" }] : []),
  },
  // Harness 2.0 W13 (WD-17; THREE_D_AND_CREATIVE.md §2): graphics
  "GX-COLOR": {
    files: js,
    find: (f) =>
      /\boutputColorSpace\b|\boutputEncoding\b/.test(f.content) && /\btoneMapping\s*=/.test(f.content)
        ? []
        : onAdded(f, /\bnew\s+(THREE\.)?WebGL(GPU)?Renderer\s*\(/, "a renderer with no output colour space or tone mapping set; set renderer.outputColorSpace and one renderer.toneMapping"),
  },
  "GX-ALLOC-LOOP": {
    files: js,
    find: (f) => {
      const hot = blockLines(f.content, ANIMATION)
      return f.added
        .filter(({ line, text }) => hot.has(line) && !commentLine(text) && /\bnew\s+(THREE\.\w+|Vector[234]|Matrix[34]|Quaternion|Color|Euler|Box3|Sphere|Ray|Raycaster)\s*\(/.test(text))
        .map(({ line }) => ({ line, why: "an allocation in the animation callback; create it once outside and reuse it" }))
    },
  },
  "GX-NO-DISPOSE": {
    files: js,
    find: (f) => {
      if (/\.dispose\s*\(/.test(f.content)) return []
      const first = f.added.find(({ text }) => !commentLine(text) && GPU_RESOURCE.test(text))
      return first ? [{ line: first.line, why: "GPU resources created with no dispose path; dispose geometries, materials, textures and targets on unmount" }] : []
    },
  },
  "GX-DPR": {
    files: js,
    find: (f) => onAdded(f, /setPixelRatio\s*\((?![^)]*\b(Math\.min|min|clamp)\s*\()[^)]*\bdevicePixelRatio\b/, "the pixel ratio follows devicePixelRatio uncapped; use Math.min(devicePixelRatio, the tier's cap)"),
  },
  "FE-ASSET-LICENCE": {
    files: (p) => ASSET.test(p),
    find: (f) => (f.isNew && !f.assetLicensed(f.path) ? [{ line: 1, why: "a new asset with no entry in scene_direction.json assets (path, licence, source)" }] : []),
  },
  "BE-SQL-INTERP": {
    files: (p) => js(p) || py(p),
    find: (f) => [
      ...onAddedSpans(f, /(\w*\.?)`[^`]*\b(SELECT|INSERT|UPDATE|DELETE)\b[^`]*\$\{[^`]*`/gi, "SQL built by string interpolation; use parameters", (m) => !/sql$/i.test(m[1])),
      ...onAdded(f, /\bf["'][^"']*\b(SELECT|INSERT|UPDATE|DELETE)\b[^"']*\{/i, "SQL built with an f-string; use parameters"),
      ...onAdded(f, /["'][^"']*\b(SELECT|INSERT|UPDATE|DELETE)\b[^"']*["']\s*\+\s*\w/i, "SQL built by concatenation; use parameters"),
    ],
  },
  "BE-EMPTY-CATCH": {
    files: (p) => js(p) || py(p) || /\.(java|kt|cs)$/.test(p),
    find: (f) => {
      const out = onAdded(f, /\bcatch\s*(\([^)]*\))?\s*\{\s*\}/, "an empty catch: the error disappears")
      const lines = f.content.split("\n")
      for (const { line, text } of f.added)
        if (/^\s*except\b[^:]*:\s*(pass)?\s*$/.test(text) && (/:\s*pass\s*$/.test(text) || /^\s*pass\s*$/.test(lines[line] ?? ""))) out.push({ line, why: "an except that only passes: the error disappears" })
      return out
    },
  },
  "BE-NO-TIMEOUT": {
    files: js,
    find: (f) => (/AbortSignal\.timeout|signal\s*:|timeout\s*:/.test(f.content) ? [] : onAdded(f, /\b(fetch|axios\.(get|post|put|patch|delete))\s*\(/, "an outbound call without a timeout or signal")),
  },
  "BE-LOG-SECRET": {
    files: (p) => js(p) || py(p),
    find: (f) => onAdded(f, /\b(console\.(log|info|warn|error|debug)|log(ger)?\.(info|warn|error|debug)|print)\s*\([^)]*\b(password|passwd|secret|api[_-]?key|apiKey|private[_-]?key|access[_-]?token|accessToken|refresh[_-]?token|refreshToken|auth[_-]?token|authToken)\b/i, "a log line that may print a secret"),
  },
  "FS-DTO-DUP": {
    files: EXT(/\.tsx?$/),
    find: (f) => {
      const mine = new Set([...f.content.matchAll(/export\s+(?:interface|type)\s+(\w+)/g)].map((m) => m[1]))
      const dup = [...mine].filter((name) => f.others.some((o) => o.path !== f.path && new RegExp(`export\\s+(?:interface|type)\\s+${name}\\b`).test(o.content)))
      return dup.flatMap((name) => onAdded(f, new RegExp(`export\\s+(?:interface|type)\\s+${name}\\b`), `${name} is declared in two files; generate one from the contract`))
    },
  },
  "MB-SYNC-IO": {
    files: mobile,
    find: (f) => onAdded(f, /\b(Data|String)\(contentsOf:|readAsStringSync\(|readAsBytesSync\(|\.execute\(\)\s*;?\s*$/, "synchronous I/O that can block the main thread"),
  },
  "MB-HARDCODE-DIM": {
    files: mobile,
    find: (f) => onAdded(f, /\b(width|height)\s*[:=(]\s*(320|360|375|390|393|412|414|428|430|768|812|844|852|896|926|932|1024)\b/, "a hard-coded screen dimension"),
  },
  "GM-ALLOC-TICK": {
    files: (p) => js(p) || /\.(cs|cpp|cc|rs)$/.test(p),
    find: (f) => {
      const lines = f.content.split("\n")
      const hot = new Set()
      for (let i = 0; i < lines.length; i++) {
        if (!/\b(update|tick|fixedUpdate|onFrame|step)\s*\([^)]*\)\s*(:\s*[\w<>[\]]+\s*)?\{/.test(lines[i])) continue
        let depth = 0
        for (let j = i; j < lines.length; j++) {
          depth += (lines[j].match(/\{/g) ?? []).length - (lines[j].match(/\}/g) ?? []).length
          if (j > i) hot.add(j + 1)
          if (depth <= 0 && j > i) break
        }
      }
      return f.added.filter(({ line, text }) => hot.has(line) && !commentLine(text) && /\bnew\s+[A-Z]\w*\s*\(|=\s*\[\s*\]|=\s*\{\s*\}/.test(text)).map(({ line }) => ({ line, why: "an allocation in the per-frame loop; pool it" }))
    },
  },
  "GM-DT-MISSING": {
    files: (p) => js(p) || /\.(cs|gd|cpp|rs)$/.test(p),
    find: (f) => onAdded(f, /\.(x|y|z)\s*[+-]=\s*[^;\n]*\b(speed|velocity|vel)\b(?![^;\n]*\b(dt|delta|deltaTime|elapsed|frameTime)\b)/, "movement without the timestep"),
  },
  "OPS-LATEST": {
    files: (p) => /(^|\/)(Dockerfile|[^/]*\.dockerfile)$/i.test(p) || /(^|\/)docker-compose[^/]*\.ya?ml$/.test(p),
    find: (f) => {
      const stages = new Set([...f.content.matchAll(/^\s*FROM\s+\S+\s+AS\s+(\S+)/gim)].map((m) => m[1].toLowerCase()))
      return f.added.flatMap(({ line, text }) => {
        const from = /^\s*FROM\s+(?:--\S+\s+)*(\S+)/i.exec(text)?.[1]
        const image = from ?? /^\s*image:\s*["']?([^"'\s]+)/.exec(text)?.[1]
        if (!image || image === "scratch" || stages.has(image.toLowerCase()) || image.startsWith("$")) return []
        if (image.includes("@sha256:")) return []
        const tag = /:([^/]+)$/.exec(image)?.[1]
        return !tag || tag === "latest" ? [{ line, why: `${image} isn't pinned to a version` }] : []
      })
    },
  },
  "OPS-SECRET-ENV": {
    files: (p) => /(^|\/)(Dockerfile|[^/]*\.dockerfile)$/i.test(p) || /(^|\/)\.github\/workflows\/|\.gitlab-ci\.yml$|(^|\/)render\.yaml$|docker-compose[^/]*\.ya?ml$/.test(p),
    find: (f) => [
      ...onAdded(f, /^\s*(ENV|ARG)\s+\w*(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY)\w*[= ]\s*\S+/i, "a secret given a value in the image"),
      ...onAdded(f, /\b\w*(secret|token|password|api_?key)\w*\s*:\s*["']?(?!\$\{\{)[A-Za-z0-9_\-/+=]{12,}["']?\s*$/i, "a secret written in a CI or deploy file"),
    ],
  },
  "OPS-MIGRATE-LOCK": {
    files: sql,
    find: (f) => [
      ...onAdded(f, /\badd\s+column\b(?![^;]*\bdefault\b)[^;]*\bnot\s+null\b/i, "a NOT NULL column without a default locks and fails on a filled table"),
      ...onAdded(f, /\bcreate\s+(unique\s+)?index\b(?!\s+concurrently)/i, "an index built without CONCURRENTLY locks writes"),
    ],
  },
  "CL-IAM-STAR": {
    files: iac,
    find: (f) => onAdded(f, /["']?(Action|Resource|actions|resources)["']?\s*[:=]\s*(\[\s*)?["']\*["']/, "a wildcard permission"),
  },
  "CL-PUBLIC": {
    files: iac,
    find: (f) => {
      const out = onAdded(f, /\bpublicly_accessible\s*=\s*true\b|\bacl\s*=\s*["']public-read(-write)?["']|\bblock_public_(acls|policy)\s*=\s*false\b/, "a publicly reachable data store")
      const lines = f.content.split("\n")
      for (const { line, text } of f.added) {
        if (!/0\.0\.0\.0\/0/.test(text)) continue
        const block = lines.slice(Math.max(0, line - 8), line + 8).join("\n")
        const ports = [...block.matchAll(/\b(from_port|to_port|port)\s*=\s*(\d+)/g)].map((m) => Number(m[2]))
        if (/\bingress\b/.test(block) && ports.some((p) => p !== 80 && p !== 443)) out.push({ line, why: "ingress from anywhere on a non-web port" })
      }
      return out
    },
  },
  "SY-UNSAFE-NOCOMMENT": {
    files: EXT(/\.rs$/),
    find: (f) => {
      const lines = f.content.split("\n")
      return f.added.filter(({ line, text }) => /\bunsafe\s*\{/.test(text) && !lines.slice(Math.max(0, line - 4), line - 1).some((l) => /SAFETY:/.test(l))).map(({ line }) => ({ line, why: "an unsafe block without a SAFETY: comment" }))
    },
  },
  "SY-SPIN": {
    files: EXT(/\.(rs|c|cc|cpp|h|hpp|go|java|m?[jt]s)$/),
    find: (f) => onAdded(f, /\bwhile\s*\(.*\)\s*(\{\s*\}|;)\s*$|\bloop\s*\{\s*\}|\bfor\s*\(\s*;\s*;\s*\)\s*\{\s*\}/, "a busy wait without backoff"),
  },
  "DT-INSERT-NOKEY": {
    files: (p) => /(^|\/)(dags|pipelines?|etl|jobs|models)\//.test(p) && (sql(p) || py(p)),
    find: (f) => onAddedSpans(f, /\binsert\s+into\b[^;]*;?/gi, "an insert a retry would repeat; upsert or merge on a key", (m) => !/\bon\s+conflict\b|\bmerge\b/i.test(m[0])),
  },
  "ML-FIT-TEST": {
    files: (p) => py(p) || /\.ipynb$/.test(p),
    find: (f) => onAdded(f, /\.(fit|fit_transform|partial_fit)\s*\([^)]*\b(X_test|x_test|test_x|test_X|test_data|test_df|test_set|y_test)\b/, "fitting on the test split"),
  },
  "ML-SEED": {
    files: (p) => /(^|\/)(train|training|eval|evaluate)[^/]*\.py$/.test(p),
    find: (f) => (f.isNew && !/random_state|manual_seed|set_seed|np\.random\.seed|random\.seed|seed\s*=/.test(f.content) ? [{ line: 1, why: "a training or evaluation entry point without a fixed seed" }] : []),
  },
  "SEC-BODY-ID": {
    files: (p) => js(p) || py(p),
    find: (f) => onAdded(f, /\b(req\.body|req\.query|req\.params|request\.json\(\)|request\.args|request\.form|searchParams\.get\(|body)\W{1,3}["']?(user_?id|tenant_?id|userId|tenantId|org_?id|orgId|owner_?id|ownerId)\b/, "an owner or tenant id taken from the request; take it from the verified session"),
  },
  "SEC-EVAL": {
    files: (p) => js(p) || py(p),
    find: (f) => [
      ...onAdded(f, /(?<![\w.])(eval|exec)\s*\(|\bnew\s+Function\s*\(/, "code built from strings at run time"),
      ...onAdded(f, /\b(child_process\.)?(exec|execSync)\s*\(\s*`[^`]*\$\{|\bos\.system\s*\(\s*f["']|\bsubprocess\.\w+\([^)]*shell\s*=\s*True/, "a shell command built from input"),
    ],
  },
  "QA-ONLY": {
    files: tests,
    find: (f) => onAdded(f, /\b(it|test|describe|context)\.only\s*\(|\bf(it|describe)\s*\(/, "a focused test that silences the rest"),
  },
  "QA-SKIP": {
    files: tests,
    find: (f) => onAdded(f, /\b(it|test|describe)\.skip\s*\(|\bx(it|describe)\s*\(|@pytest\.mark\.skip|\bt\.Skip\(/, "a newly skipped test"),
  },
  "SD-SLEEP": {
    files: tests,
    find: (f) => onAdded(f, /\bwaitForTimeout\s*\(|\btime\.sleep\s*\(|\bThread\.sleep\s*\(|\bawait\s+sleep\s*\(|new\s+Promise\s*\(\s*\(?\s*\w+\s*\)?\s*=>\s*setTimeout\s*\(/, "a fixed sleep in a test; wait for a condition"),
  },
  "SD-XPATH": {
    files: tests,
    find: (f) => onAdded(f, /xpath=|["']\/\/\w+\[|:nth-child\(|["']\/html\/body/, "a brittle selector; use role, label or test id"),
  },
  "DB-NO-RLS": {
    files: sql,
    find: (f) =>
      onAddedSpans(f, /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?([\w."]+)/gi, "a table without row-level security in the same migration", (m) => {
        const name = m[1].replace(/"/g, "")
        if (!f.tenantTables(name)) return false
        const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        return !new RegExp(`alter\\s+table\\s+(only\\s+)?"?${esc.replace(/\\\./g, '"?\\."?')}"?\\s+enable\\s+row\\s+level\\s+security`, "i").test(f.content)
      }),
  },
  "DB-FK-NOINDEX": {
    files: sql,
    find: (f) =>
      f.added.flatMap(({ line, text }) => {
        const col = /^\s*"?(\w+)"?\s+[\w ()]+\breferences\b/i.exec(text)?.[1]
        if (!col) return []
        return new RegExp(`create\\s+(unique\\s+)?index[^;]*\\(\\s*"?${col}"?`, "i").test(f.content) ? [] : [{ line, why: `the foreign key ${col} has no index` }]
      }),
  },
  "DB-DROP": {
    files: sql,
    find: (f) => onAdded(f, /\bdrop\s+(table|column)\b|\balter\s+column\s+\w+\s+(set\s+data\s+)?type\b/i, "a destructive change; plan it in two releases"),
  },
}

/** High-entropy secrets and known key shapes on added lines (G-SECRETS); the value itself is never returned. */
export const SECRET_RULES = [
  ["an AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["a GitHub token", /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ["a Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["a Stripe live key", /\b(sk|rk)_live_[A-Za-z0-9]{20,}\b/],
  ["a Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["an Anthropic or OpenAI key", /\bsk-(ant-)?[A-Za-z0-9_-]{32,}\b/],
  ["a private key", /-----BEGIN ([A-Z]+ )?PRIVATE KEY-----/],
  ["a JSON web token", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
]
const SECRET_ASSIGN = /\b\w*(secret|token|password|passwd|api[_-]?key|private[_-]?key|access[_-]?key)\w*["']?\s*[:=]\s*["']([^"'\s]{32,})["']/i
const NOT_SECRETS = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|go\.sum)$|\.min\.(js|css)$|\.(png|jpe?g|gif|webp|woff2?|ttf|otf|ico|pdf|zip|gz)$/

/** @param {{ path: string, added: Array<{ line: number, text: string }> }} file */
export function findSecrets(file) {
  if (NOT_SECRETS.test(file.path)) return []
  const out = []
  if (/(^|\/)\.env(\.[\w-]+)?$/.test(file.path) && !/\.(example|sample|template)$/.test(file.path)) out.push({ line: 1, why: "an environment file is in the changes; keep it out of git" })
  for (const { line, text } of file.added) {
    const rule = SECRET_RULES.find(([, re]) => re.test(text))
    if (rule) out.push({ line, why: rule[0] })
    else {
      const m = SECRET_ASSIGN.exec(text)
      if (m && shannon(m[2]) >= 4.5 && !/^\$\{|^process\.env|^os\.environ|^<|^your[_-]|^xxx|^changeme/i.test(m[2])) out.push({ line, why: "a high-entropy secret value" })
    }
  }
  return out
}
