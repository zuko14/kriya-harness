// Kriya Harness brand and theme, browser half (DESIGN.md). Source file:
// scripts/build-brand.js inlines the fonts and writes ../client.js, the
// module DSH loads. Edit this file, then run `npm run build:brand`.
//
// Everything goes through seams DeepSeek Harness offers other identities:
// theme token overrides (ctx.theme.overrideTokens, light and dark pairs),
// the brand slots (sidebar mark and name, conversation hero mark) and
// plugin-owned styles. No DSH file is edited (HD-02).
window.__ModuleLoader__.load({
  id: "@kriya-ai/harness-brand",
  factory: (require) => {
    const { jsx, jsxs } = require("react/jsx-runtime")
    const { useEffect, useState } = require("react")

    const PLUGIN = "@kriya-ai/harness-brand"
    const PRODUCT = "Kriya Harness"
    const UPSTREAM = "DeepSeek Harness"

    /* ───────────────────────────── palette ───────────────────────────── */

    // Kriya's colours (the Kriya app's globals.css) on DSH's tokens.
    // [light, dark]; DSH picks the pair's half for the active scheme
    const INK = ["19 41 43", "242 234 223"]
    const ink = (alpha) => INK.map((rgb) => `rgb(${rgb} / ${alpha})`)
    const TEAL = ["#1F6362", "#6CC0B8"]
    const teal = (alpha) => [`rgb(31 99 98 / ${alpha})`, `rgb(108 192 184 / ${alpha})`]
    const SAFFRON = ["#B4622F", "#E7A46D"]
    const saffron = (alpha) => [`rgb(180 98 47 / ${alpha})`, `rgb(231 164 109 / ${alpha})`]

    const PAPER = ["#F3EEE6", "#0A1213"]
    const SHEET = ["#FBF8F3", "#122021"]
    const SHEET_2 = ["#FFFDF9", "#172A2B"]
    const LOOM = ["#EAE3D7", "#071011"]

    const FONT_TEXT = `"KH Geist", "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", Helvetica, Arial, sans-serif`
    const FONT_CODE = `"KH JetBrains Mono", "JetBrains Mono", "SF Mono", Consolas, "Liberation Mono", Menlo, monospace`
    const FONT_DISPLAY = `"KH Fraunces", Georgia, "Times New Roman", serif`

    const TOKENS = {
      // Surfaces
      "--dsw-alias-bg-base": PAPER,
      "--dsw-alias-bg-layer-1": SHEET,
      "--dsw-alias-bg-layer-2": SHEET_2,
      "--dsw-alias-bg-layer-3": ["#FFFFFF", "#1C3132"],
      "--dsw-alias-bg-overlay": SHEET,
      "--dsw-alias-bg-module-platform": ["#EFE9DF", "#0F1C1D"],
      "--dsw-alias-bg-multi-select": ["#EFE9DF", "#0F1C1D"],
      "--dsw-alias-bg-document-preview": LOOM,
      "--dsw-alias-bg-document-selection": teal(0.3),
      "--dsw-alias-bg-skeleton": ink(0.05),
      "--dsw-specific-sidebar-fill": LOOM,
      "--dsw-specific-sidebar-nav-item-hover": ink(0.055),
      "--dsw-specific-sidebar-nav-item-active": ink(0.085),
      "--dsw-specific-sidebar-nav-item-active-accent": teal(0.14),
      "--dsw-specific-input-major": SHEET_2,
      "--dsw-specific-login-input": SHEET,
      "--dsw-specific-menu": ["rgb(251 248 243 / 0.92)", "rgb(18 32 33 / 0.9)"],
      "--dsw-alias-menu-group-header-fill": ["rgb(251 248 243 / 0.95)", "rgb(18 32 33 / 0.95)"],
      "--dsw-specific-selector": ink(0.05),
      "--dsw-specific-tip": ink(0.05),
      // The person's own messages: a teal-dyed sheet
      "--dsw-specific-bubble": teal(0.11),
      "--dsw-specific-bubble-highlight": teal(0.2),
      "--dsw-alias-turn-trigger-bg": ["#EFE9DF", "#0F1C1D"],
      "--dsw-alias-turn-trigger-bg-hover": ink(0.07),
      "--dsw-alias-settings-card-fill": SHEET_2,
      "--dsw-alias-settings-card-stroke": ink(0.14),

      // Text
      "--dsw-alias-label-primary": ["#13292B", "#F2EADF"],
      "--dsw-alias-label-primary-dimmed": ["#1C3436", "#E6DED2"],
      "--dsw-alias-label-primary-bluish": ["#174C4B", "#9FD8D1"],
      "--dsw-alias-label-primary-inverted": ["#FBF8F3", "#0A1213"],
      "--dsw-alias-label-primary-foreground": ["#FBF8F3", "#0D1A1B"],
      "--dsw-alias-label-secondary": ["#4C5F60", "#A8B8B5"],
      "--dsw-alias-label-tertiary": ["#56686A", "#8A9B98"],
      "--dsw-alias-label-caption": ["#6C7B7A", "#6F817F"],
      "--dsw-alias-label-dimmed": ["#D8D0C3", "#2A3B3C"],
      "--dsw-alias-label-document-preview": ["#4C5F60", "#A8B8B5"],
      "--dsw-alias-brand-primary": ["#13292B", "#F2EADF"],
      "--dsw-alias-brand-primary-invert": ["#13292B", "#F2EADF"],
      "--dsw-alias-brand-text": ["#13292B", "#F2EADF"],
      "--dsw-alias-link": TEAL,
      "--dsw-alias-menu-icon": ["#2E4446", "#C9D4D1"],

      // Action: teal replaces DSH's blue everywhere it means "do this"
      "--dsw-alias-state-business-primary": TEAL,
      "--dsw-alias-state-business-tertiary": teal(0.13),
      "--dsw-alias-brand-primary-new-colorprimary-new-color": TEAL,
      "--dsw-alias-button-info-fill": TEAL,
      "--dsw-alias-button-info-hover": ["#2A7A78", "#8FD3CB"],
      "--dsw-alias-onboarding-accent": TEAL,
      "--dsw-alias-button-primary-fill": ["#173A3D", "#F2EADF"],
      "--dsw-alias-button-primary-hover": ["#22504F", "#FFF8EE"],
      "--dsw-alias-button-primary-dimmed": ink(0.08),
      "--dsw-alias-button-contrast-fill": ["#4C5F60", "#A8B8B5"],
      "--dsw-alias-button-elevated-fill": SHEET_2,
      "--dsw-alias-button-floating-fill": SHEET_2,
      "--dsw-alias-button-floating-hover": ["#F2ECE2", "#1C3132"],
      "--dsw-alias-button-ghost-active-fill": ink(0.07),
      "--dsw-alias-button-ghost-active-hover": ink(0.1),
      "--dsw-alias-button-ghost-active-border": ink(0.3),
      "--dsw-alias-interactive-bg-hover": ink(0.05),
      "--dsw-alias-interactive-bg-active": ink(0.09),
      "--dsw-alias-interactive-bg-hover-accent": teal(0.15),
      "--dsw-alias-interactive-bg-hover-solid": ["#ECE6DC", "#172A2B"],
      "--dsw-alias-interactive-bg-hover-danger": ["rgb(194 65 58 / 0.08)", "rgb(240 122 110 / 0.1)"],
      "--dsw-alias-switch-thumb": ["#FFFDF9", "#A8B8B5"],

      // The agent at work: saffron thread instead of DSH's blue sweep
      "--dsw-alias-label-deep-diving": ["#8F4C1F", "#E7A46D"],
      "--dsw-alias-label-deep-diving-shimmer": ["#E09A62", "#F6D2AE"],

      // States (Kriya's own; saffron carries warnings)
      "--dsw-alias-state-success-primary": ["#2C8A5F", "#6FD3A0"],
      "--dsw-alias-state-success-secondary": ["#3FA673", "#8BDDB3"],
      "--dsw-alias-state-success-tertiary": ["rgb(44 138 95 / 0.12)", "rgb(111 211 160 / 0.14)"],
      "--dsw-alias-state-error-primary": ["#C2413A", "#F07A6E"],
      "--dsw-alias-state-error-secondary": ["#D9655E", "#F49A90"],
      "--dsw-alias-state-warn-primary": SAFFRON,
      "--dsw-alias-state-warn-secondary": ["#C77A45", "#EDB688"],
      "--dsw-alias-state-warn-tertiary": saffron(0.13),
      "--dsw-alias-state-warn-label": ["#8F4C1F", "#E7A46D"],
      "--dsw-alias-state-idle-primary": ["#CFC6B8", "#3A4B4C"],

      // Lines
      "--dsw-alias-border-l1": ink(0.06),
      "--dsw-alias-border-l2": ink(0.11),
      "--dsw-alias-border-l2-darkmode-thin": ink(0.11),
      "--dsw-alias-border-l3": ink(0.14),
      "--dsw-alias-border-l4": ink(0.2),

      // Replies
      "--dsw-alias-markdown-code-block": ["#EDE7DD", "#0E1A1B"],
      "--dsw-alias-markdown-code-block-banner": ["#E6DFD3", "#0B1617"],
      "--dsw-alias-markdown-inline-code": ink(0.065),
      "--dsw-alias-markdown-citation": teal(0.11),
      "--dsw-alias-markdown-tag": ink(0.06),
      "--dsw-alias-markdown-placeholder": ink(0.05),
      "--dsw-alias-markdown-code-segment-selected": SHEET_2,
      "--dsw-alias-markdown-code-segment-unselected": ["#E6DFD3", "#0B1617"],

      // Small surfaces
      "--dsw-alias-scrollbar-bg-l1": ink(0.16),
      "--dsw-alias-scrollbar-bg-l2": ink(0.16),
      "--dsw-alias-scrollbar-hover-l1": ink(0.28),
      "--dsw-alias-scrollbar-hover-l2": ink(0.28),
      "--dsw-alias-toast-bg": ["#13292B", "#F2EADF"],
      "--dsw-alias-toast-label": ["#FBF8F3", "#0D1A1B"],
      "--dsw-alias-tooltip-bg": ["#13292B", "#22393A"],
      "--dsw-alias-tooltip-key-bg": ["#2A4547", "#34504F"],

      // The start screen's thread: light on the dark K, dark on the cream K
      "--kh-thread": ["#E7A46D", "#9A5424"],

      // Type. A font chosen in Settings still comes first (DSH puts the
      // person's list ahead of these defaults)
      "--dsh-font-family-text-default": [FONT_TEXT, FONT_TEXT],
      "--dsh-font-family-code-default": [FONT_CODE, FONT_CODE],
      "--dsw-font-family-brand": [FONT_DISPLAY, FONT_DISPLAY],
    }

    /** { token: { light, dark } }, the shape ctx.theme.overrideTokens takes */
    const overrides = () =>
      Object.fromEntries(Object.entries(TOKENS).map(([name, [light, dark]]) => [name, { light, dark }]))

    /* ─────────────────────────────── mark ────────────────────────────── */

    // Kriya's mark (components/brand.tsx in the Kriya app): split stem,
    // rising arm, blade leg, and the terracotta leaf where they meet
    const K_PATHS = [
      "M17 13h8.5v17.5L17 39z",
      "M17 44l8.5-8.5V51H17z",
      "M29 31 43 13h9.5L33.5 35z",
      "M30 39.5c9.5 0.5 17 4.5 22 11.5H41.5c-4.5-3.5-8.5-7.2-11.5-11.5z",
    ]
    const LEAF = "M33.5 36.5c4.6-3.6 10-4.8 15.5-3.8-4.4 4-9.8 5.3-15.5 3.8z"

    const tileSvg = () =>
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
      '<rect width="64" height="64" rx="18" fill="#1F4F50"/>' +
      '<g transform="translate(6.4 6.4) scale(0.8)" fill="#FCE6C6">' +
      K_PATHS.map((d) => `<path d="${d}"/>`).join("") +
      `<path d="${LEAF}" fill="#E09A62"/></g></svg>`

    /** The tile: sidebar and tab icon */
    function KriyaMark({ size = 24, className }) {
      return jsxs("svg", {
        viewBox: "0 0 64 64",
        width: size,
        height: size,
        className,
        role: "img",
        "aria-label": "Kriya",
        children: [
          jsx("rect", { width: 64, height: 64, rx: 18, fill: "#1F4F50" }),
          jsxs("g", {
            transform: "translate(6.4 6.4) scale(0.8)",
            fill: "#FCE6C6",
            children: [
              ...K_PATHS.map((d) => jsx("path", { d }, d)),
              jsx("path", { d: LEAF, fill: "#E09A62" }, "leaf"),
            ],
          }),
        ],
      })
    }

    function KriyaName() {
      return jsxs("span", {
        className: "kh-name",
        children: [PRODUCT, jsx("span", { className: "kh-name-beta", children: "beta" })],
      })
    }

    /* ─────────────────────── the start screen (hero) ─────────────────── */

    // The one memorable thing (DESIGN.md): the K is stitched in saffron
    // thread, then fills in, then the question appears. Once per page load
    let stitchedThisLoad = false

    function StitchedK() {
      // A remount (new session) shows it finished, not stitching again
      const [animate, setAnimate] = useState(() => {
        const first = !stitchedThisLoad
        stitchedThisLoad = true
        return first
      })
      // Once sewn, drop the animation: DSH moving the hero (a layout change)
      // would otherwise make the browser play it again
      useEffect(() => {
        if (!animate) return
        const done = setTimeout(() => setAnimate(false), 1600)
        return () => clearTimeout(done)
      }, [animate])
      const parts = [...K_PATHS, LEAF]
      return jsxs("svg", {
        className: `kh-stitch${animate ? " kh-stitch-play" : ""}`,
        viewBox: "8 8 50 48",
        role: "img",
        "aria-label": "Kriya",
        children: [
          jsx("defs", {
            children: parts.flatMap((d, i) => [
              // Reveals the thread along the stroke, as if sewn in
              jsx(
                "mask",
                {
                  id: `kh-reveal-${i}`,
                  maskUnits: "userSpaceOnUse",
                  children: jsx("path", {
                    d,
                    className: "kh-reveal",
                    style: { animationDelay: `${i * 0.12}s` },
                    pathLength: 100,
                  }),
                },
                `m${i}`
              ),
              // Keeps the thread inside its shape: a topstitch, not an outline
              jsx("clipPath", { id: `kh-inside-${i}`, children: jsx("path", { d }) }, `c${i}`),
            ]),
          }),
          // The cloth: the filled K, dyed in after the stitching
          jsxs("g", {
            className: "kh-cloth",
            children: [
              ...K_PATHS.map((d) => jsx("path", { d }, `f${d}`)),
              jsx("path", { d: LEAF, className: "kh-leaf" }, "fleaf"),
            ],
          }),
          // The thread: a running stitch along every edge
          jsx("g", {
            className: "kh-thread",
            children: parts.map((d, i) =>
              jsx(
                "g",
                {
                  clipPath: `url(#kh-inside-${i})`,
                  className: i === parts.length - 1 ? "kh-thread-leaf" : undefined,
                  // No pathLength here: stitches keep one length on every stroke
                  children: jsx("path", { d, mask: `url(#kh-reveal-${i})` }),
                },
                `t${i}`
              )
            ),
          }),
        ],
      })
    }

    function KriyaHero() {
      return jsxs("span", {
        className: "kh-hero",
        "data-kriya-hero": "",
        children: [
          jsx(StitchedK, {}),
          jsx("span", { className: "kh-hero-question", children: "What are we working on?" }),
          jsx("span", {
            className: "kh-hero-note",
            children: "Runs in this folder on your computer. Model use counts toward your Kriya plan.",
          }),
        ],
      })
    }

    /* ────────────────────────────── styles ───────────────────────────── */

    const CSS = `
__KRIYA_FONT_FACES__

.kh-name {
  font-family: var(--dsw-font-family-brand);
  font-size: 16px;
  font-weight: 560;
  font-variation-settings: "opsz" 24, "SOFT" 50;
  letter-spacing: -0.012em;
  white-space: nowrap;
  color: var(--dsw-alias-label-primary);
}
.kh-name-beta {
  margin-left: 0.45em;
  padding: 1px 6px 2px;
  border-radius: 999px;
  corner-shape: round;
  font-family: var(--dsw-font-family);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.01em;
  vertical-align: 2px;
  color: var(--dsw-alias-state-warn-label);
  background: var(--dsw-alias-state-warn-tertiary);
}

/* The hero replaces DSH's headline and badge: they are the next sibling of
   the span holding the mark slot (tests/brand.test.js pins that structure) */
span:has(.kh-hero) + span { display: none !important; }
/* DSH sizes the mark's box to its content and never shrinks it; the hero
   must fit the column instead, down to phone width */
span:has(> div > .kh-hero) { flex: 1 1 auto; min-width: 0; max-width: 100%; }
.kh-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  max-width: 100%;
  text-align: center;
}
.kh-stitch {
  width: 76px;
  height: 76px;
  overflow: visible;
}
.kh-cloth path { fill: var(--dsw-alias-label-primary); }
.kh-cloth .kh-leaf { fill: #E09A62; }
/* Drawn twice as wide as it shows: the clip keeps the inner half, so the
   stitches sit just inside each edge */
.kh-thread path {
  fill: none;
  stroke: var(--kh-thread, #E7A46D);
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-dasharray: 1.5 1.15;
}
.kh-thread-leaf path { stroke: #8A4A21; }
.kh-reveal {
  fill: none;
  stroke: #fff;
  stroke-width: 4;
  stroke-dasharray: 100;
  stroke-dashoffset: 0;
}
.kh-hero-question {
  font-family: var(--dsw-font-family-brand);
  font-size: 34px;
  line-height: 40px;
  font-weight: 380;
  font-variation-settings: "opsz" 96, "SOFT" 100;
  letter-spacing: -0.018em;
  color: var(--dsw-alias-label-primary);
  text-wrap: balance;
}
.kh-hero-note {
  max-width: min(46ch, 100%);
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-tertiary);
}

@media (prefers-reduced-motion: no-preference) {
  .kh-stitch-play .kh-reveal { animation: kh-sew 0.8s cubic-bezier(.55, .1, .35, 1) both; }
  .kh-stitch-play .kh-cloth { animation: kh-dye 0.45s ease-out 0.75s both; }
  .kh-stitch-play ~ .kh-hero-question { animation: kh-rise 0.45s ease-out 0.9s both; }
  .kh-stitch-play ~ .kh-hero-note { animation: kh-rise 0.45s ease-out 1s both; }
}
@keyframes kh-sew { from { stroke-dashoffset: 100; } to { stroke-dashoffset: 0; } }
@keyframes kh-dye { from { opacity: 0; } to { opacity: 1; } }
@keyframes kh-rise { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

::selection { background: var(--dsw-alias-bg-document-selection); }
@media (max-width: 520px) {
  .kh-hero-question { font-size: 28px; line-height: 34px; }
  .kh-stitch { width: 64px; height: 64px; }
}
`

    function installStyles() {
      const tag = document.createElement("style")
      tag.dataset.plugin = PLUGIN
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    /* ─────────────────────────── title and icon ──────────────────────── */

    /** "<session> — DeepSeek Harness" → "<session> — Kriya Harness"; unchanged otherwise. */
    function kriyaTitle(title) {
      return title.endsWith(UPSTREAM) ? title.slice(0, -UPSTREAM.length) + PRODUCT : title
    }

    function keepTitleAndIcon() {
      const icon = `data:image/svg+xml,${encodeURIComponent(tileSvg())}`
      for (const link of document.querySelectorAll('link[rel~="icon"]')) link.href = icon
      const fix = () => {
        const next = kriyaTitle(document.title)
        if (next !== document.title) document.title = next
      }
      fix()
      // DSH's layout rewrites <title> per session
      const observer = new MutationObserver(fix)
      observer.observe(document.head, { subtree: true, childList: true, characterData: true })
      return () => observer.disconnect()
    }

    /* ─────────────────────────────── apply ───────────────────────────── */

    const inject = ["slots", "theme"]

    function apply(ctx) {
      if (typeof document !== "undefined") {
        ctx.effect(installStyles, "kriya: styles and fonts")
        ctx.effect(keepTitleAndIcon, "kriya: title and icon")
      }
      ctx.effect(() => ctx.theme.overrideTokens(PLUGIN, overrides()), "kriya: theme tokens")
      // One declaration-aware set, as dsh-client-ui-brand-official registers its own
      ctx.slots.inject("sidebar.brand.mark", () =>
        ctx.slots.inject("sidebar.brand.name", function* () {
          yield ctx.slots.register({ name: "sidebar.brand.mark" }, KriyaMark)
          yield ctx.slots.register({ name: "sidebar.brand.name" }, KriyaName)
        })
      )
      ctx.slots.inject("conversation.hero.brand.mark", function* () {
        yield ctx.slots.register({ name: "conversation.hero.brand.mark" }, KriyaHero)
      })
    }

    return { apply, inject, kriyaTitle, TOKENS, CSS }
  },
})
