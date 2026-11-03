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
    // [light, dark]; DSH picks the pair's half for the active scheme.
    // tint(rgbs)(alpha): a colour at one alpha, or at a [light, dark] pair
    const tint = (rgbs) => (alpha) =>
      rgbs.map((rgb, i) => `rgb(${rgb} / ${Array.isArray(alpha) ? alpha[i] : alpha})`)
    const INK = ["19 41 43", "242 234 223"]
    const ink = tint(INK)
    const TEAL = ["#1F6362", "#6CC0B8"]
    const teal = tint(["31 99 98", "108 192 184"])
    const SAFFRON = ["#B4622F", "#E7A46D"]
    const saffron = tint(["180 98 47", "231 164 109"])

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
      "--dsw-specific-sidebar-nav-item-active": ["rgb(255 255 255 / 0.62)", "rgb(242 234 223 / 0.08)"],
      "--dsw-specific-sidebar-nav-item-active-accent": teal(0.14),
      "--dsw-specific-input-major": SHEET_2,
      "--dsw-specific-login-input": SHEET,
      "--dsw-alias-menu-group-header-fill": ["rgb(251 248 243 / 0.95)", "rgb(18 32 33 / 0.95)"],
      "--dsw-specific-selector": ink(0.05),
      "--dsw-specific-tip": ink(0.05),
      // The person's own messages: a teal-dyed sheet
      "--dsw-specific-bubble": teal(0.11),
      "--dsw-specific-bubble-highlight": teal(0.2),
      "--dsw-alias-turn-trigger-bg": ["#EFE9DF", "#0F1C1D"],
      "--dsw-alias-turn-trigger-bg-hover": ink(0.07),
      "--dsw-alias-settings-card-fill": ["rgb(255 255 255 / 0.55)", "rgb(242 234 223 / 0.05)"],
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

      // Glass (DESIGN.md, Material): sheet tinted panes over a lit ground.
      // The ground: paper lit teal from the top left, warm from the bottom right
      "--kh-ground-a": teal([0.12, 0.1]),
      "--kh-ground-b": saffron([0.09, 0.06]),
      // The pool of light the start screen's K sits in
      "--kh-halo": ["rgb(255 255 255 / 0.9)", "rgb(108 192 184 / 0.09)"],
      // Panes: thin for the sidebar, thick where text is typed or read
      "--kh-glass": ["rgb(251 248 243 / 0.55)", "rgb(18 32 33 / 0.5)"],
      "--kh-glass-thick": ["rgb(253 251 247 / 0.76)", "rgb(21 37 38 / 0.74)"],
      "--kh-blur": ["blur(28px) saturate(170%)", "blur(28px) saturate(140%)"],
      // Light caught on a pane's top edge, and its hairline
      "--kh-rim": [
        "inset 0 1px 0 0 rgb(255 255 255 / 0.9), inset 0 0 0 0.5px rgb(19 41 43 / 0.1)",
        "inset 0 1px 0 0 rgb(255 255 255 / 0.075), inset 0 0 0 0.5px rgb(242 234 223 / 0.1)",
      ],
      "--kh-edge": ink([0.1, 0.09]),
      // Wells sit below the pane, chips sit on it
      "--kh-well": ink([0.045, 0.05]),
      "--kh-chip": ["rgb(255 255 255 / 0.7)", "rgb(242 234 223 / 0.075)"],
      "--kh-chip-hover": ["rgb(255 255 255 / 0.92)", "rgb(242 234 223 / 0.11)"],
      "--kh-shade": ["rgb(19 41 43 / 0.08)", "rgb(0 0 0 / 0.35)"],
      // Lift: how far a pane floats above the ground
      "--kh-lift": [
        "0 1px 1px rgb(19 41 43 / 0.03), 0 6px 16px -4px rgb(19 41 43 / 0.08), 0 22px 44px -18px rgb(19 41 43 / 0.14)",
        "0 1px 1px rgb(0 0 0 / 0.25), 0 10px 28px -6px rgb(0 0 0 / 0.42), 0 28px 56px -22px rgb(0 0 0 / 0.5)",
      ],
      "--kh-lift-high": [
        "0 2px 4px rgb(19 41 43 / 0.04), 0 16px 40px -8px rgb(19 41 43 / 0.16), 0 44px 88px -24px rgb(19 41 43 / 0.2)",
        "0 2px 4px rgb(0 0 0 / 0.3), 0 20px 48px -8px rgb(0 0 0 / 0.55), 0 48px 96px -24px rgb(0 0 0 / 0.6)",
      ],
      // Focus: a teal edge and a soft halo; approvals: the same in saffron
      "--kh-focus-edge": teal([0.5, 0.55]),
      "--kh-focus-halo": teal([0.12, 0.14]),
      "--kh-warn-edge": saffron([0.45, 0.4]),
      "--kh-warn-halo": saffron([0.1, 0.1]),
      "--kh-bubble-rim": [
        "inset 0 1px 0 0 rgb(255 255 255 / 0.55), inset 0 0 0 0.5px rgb(31 99 98 / 0.16)",
        "inset 0 1px 0 0 rgb(255 255 255 / 0.06), inset 0 0 0 0.5px rgb(108 192 184 / 0.16)",
      ],
      "--kh-press-shadow": teal([0.35, 0.3]),

      // DSH's own glass and radii, tuned to the panes above
      "--dsw-specific-menu": ["rgb(252 250 246 / 0.8)", "rgb(22 38 39 / 0.8)"],
      "--dsw-menu-backdrop-filter": ["blur(32px) saturate(180%)", "blur(32px) saturate(150%)"],
      "--dsw-alias-bg-mask-1": ["rgb(19 41 43 / 0.16)", "rgb(2 6 7 / 0.55)"],
      "--dsw-mask-blur": ["blur(8px)", "blur(8px)"],
      "--dsw-radius-panel": ["24px", "24px"],

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
    // The K's strokes span x 17–52.5 and y 13–51: its optical centre is
    // (34.75, 32), not the 64-unit tile's (32, 32). Every placement below
    // centres that box, so the mark sits true in the tile and on the start
    // screen (it used to sit 2.2 units right of centre)
    const K_TILE = "translate(4.2 6.4) scale(0.8)"

    const tileSvg = () =>
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
      '<rect width="64" height="64" rx="18" fill="#1F4F50"/>' +
      `<g transform="${K_TILE}" fill="#FCE6C6">` +
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
            transform: K_TILE,
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
        // 50 × 48 around the K's centre (34.75, 32)
        viewBox: "9.75 8 50 48",
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

    /* ──────────────────────────── the material ───────────────────────── */

    // Glass over cloth (DESIGN.md, Material). DSH's panes keep their layout
    // and behaviour; these rules only change what they're made of. Every
    // DSH class named here is checked against the pinned DSH
    // (tests/brand.test.js), so a bump that renames one fails a test first.
    // Rules sit under html[data-kh-glass] (set by installStyles): it outranks
    // DSH's single-class rules whatever order the stylesheets load in.
    //
    // A pane's glass is drawn on its ::before, never on the pane: a
    // backdrop-filter on the pane itself would trap DSH's position: fixed
    // children (the collapsed sidebar's buttons) inside it.
    const G = "html[data-kh-glass]"
    const PANES = [
      ".hHd-Xa_root:not(.hHd-Xa_collapsed)", // sidebar
      ".uV2eYG_card", // composer
      ".mna1RW_card", // approval
      ".VOzbGW_panel", // settings
    ]
    // A plain selector list, not :is(): each pane keeps its own specificity,
    // so a pane's own rule below wins over these shared ones
    const panes = (suffix = "") => PANES.map((pane) => `${G} ${pane}${suffix}`).join(",\n")

    // Fine grain on the ground, so the glass has something to bend
    const GRAIN =
      "data:image/svg+xml," +
      encodeURIComponent(
        "<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'>" +
          "<filter id='g'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/>" +
          "<feColorMatrix values='0 0 0 0 .5 0 0 0 0 .5 0 0 0 0 .5 .09 0 0 0 0'/></filter>" +
          "<rect width='100%' height='100%' filter='url(#g)'/></svg>"
      )

    const GLASS_CSS = `
${G} body {
  --kh-ease: cubic-bezier(.2, .8, .2, 1);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
}
/* DSH's elevations, re-declared on every element as DSH does, so all its
   other floating surfaces share the panes' lift */
${G} body, ${G} body * {
  --dsw-elevation-soft: var(--dsw-elevation-stroke), var(--kh-lift);
  --dsw-elevation-panel: var(--dsw-elevation-stroke), var(--kh-lift);
  --dsw-elevation-prominent: var(--dsw-elevation-stroke), var(--kh-lift-high);
}

/* ── The ground ── */
${G} .pI_x6G_frame {
  background-color: var(--dsw-alias-bg-base);
  background-image:
    url("${GRAIN}"),
    radial-gradient(80vmax 60vmax at 30% -10%, var(--kh-ground-a), transparent 62%),
    radial-gradient(70vmax 55vmax at 100% 100%, var(--kh-ground-b), transparent 60%);
}
${G} .pI_x6G_frame::before,
${G} .pI_x6G_sidebarCol,
${G} .pI_x6G_centerCol,
${G} .pI_x6G_rightbarCol { background: transparent; }

/* ── Panes ── */
${panes()} {
  position: relative;
  isolation: isolate;
  background: transparent;
  box-shadow: var(--kh-lift);
  transition: box-shadow .24s var(--kh-ease);
}
${panes("::before")} {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1;
  border-radius: inherit;
  pointer-events: none;
  background: var(--kh-pane, var(--kh-glass));
  -webkit-backdrop-filter: var(--kh-blur);
  backdrop-filter: var(--kh-blur);
  box-shadow: var(--kh-rim);
  transition: box-shadow .24s var(--kh-ease);
}

/* Sidebar: a pane floating on the ground, inset from the window's edges.
   DSH sizes the sidebar inline (it resizes), so only the glass is inset
   and the content padded to sit inside it */
${G} .hHd-Xa_root:not(.hHd-Xa_collapsed) {
  --dsh-sidebar-inline-padding: 20px;
  padding-top: 16px;
  padding-bottom: 14px;
  box-shadow: none;
}
${G} .hHd-Xa_root:not(.hHd-Xa_collapsed)::before {
  inset: 10px 6px 10px 10px;
  border-radius: 22px;
  box-shadow: var(--kh-rim), 0 1px 1px var(--kh-shade), 0 14px 32px -22px var(--kh-shade);
}
${G} .hHd-Xa_footArea { background: transparent; }
/* The list's scroll fade is painted in DSH's solid sidebar colour, which
   would show as a band on glass */
${G} .bhn1Oq_fade { display: none; }
${G} .YDXeBa_sessionRow { border-radius: 10px; }
${G} .YDXeBa_sessionRow.YDXeBa_selected { background: var(--kh-chip); box-shadow: var(--kh-rim); }
${G} .hHd-Xa_root:not(.hHd-Xa_collapsed) .hHd-Xa_newSession {
  height: 40px;
  border: 0;
  border-radius: 14px;
  background: var(--kh-chip);
  box-shadow: var(--kh-rim), 0 1px 2px var(--kh-shade), 0 6px 14px -8px var(--kh-shade);
  transition: background-color .18s var(--kh-ease), transform .18s var(--kh-ease);
}
${G} .hHd-Xa_root:not(.hHd-Xa_collapsed) .hHd-Xa_newSession:hover { background: var(--kh-chip-hover); }
${G} .hHd-Xa_root:not(.hHd-Xa_collapsed) .hHd-Xa_newSession svg { color: var(--dsw-alias-link); }
${G} .hHd-Xa_panelRow { border-radius: 10px; transition: background-color .16s var(--kh-ease); }

/* Composer: the thickest pane, where the person types; it lights teal
   while it has focus */
${G} .uV2eYG_card { --kh-pane: var(--kh-glass-thick); }
${G} .uV2eYG_card:focus-within { box-shadow: 0 0 0 4px var(--kh-focus-halo), var(--kh-lift); }
${G} .uV2eYG_card:focus-within::before { box-shadow: var(--kh-rim), inset 0 0 0 1px var(--kh-focus-edge); }
${G} .uV2eYG_primary {
  color: var(--dsw-alias-label-primary-foreground);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / .28), inset 0 -1px 0 rgb(0 0 0 / .14), 0 6px 14px -5px var(--kh-press-shadow);
  transition: background-color .18s var(--kh-ease), transform .18s var(--kh-ease), box-shadow .18s var(--kh-ease);
}
${G} .uV2eYG_primary:active:not(:disabled) { transform: translateY(-2px) scale(.93); }
${G} .uV2eYG_primary:disabled {
  opacity: 1;
  color: var(--dsw-alias-label-tertiary);
  background: var(--kh-well);
  box-shadow: inset 0 0 0 .5px var(--kh-edge);
}

/* Approval: the same pane, edged in saffron while it waits */
${G} .mna1RW_card {
  --kh-pane: var(--kh-glass-thick);
  border-color: var(--kh-warn-edge);
  box-shadow: 0 0 0 4px var(--kh-warn-halo), var(--kh-lift);
}

/* Settings: a pane over a blurred scrim, its sections on a quiet well */
${G} .VOzbGW_panel { --kh-pane: var(--kh-glass-thick); box-shadow: var(--kh-lift-high); }
${G} .VOzbGW_nav { background: var(--kh-well); box-shadow: inset -0.5px 0 0 var(--kh-edge); }
${G} .VOzbGW_navTitle {
  font-family: var(--dsw-font-family-brand);
  font-size: 22px;
  line-height: 28px;
  font-weight: 440;
  font-variation-settings: "opsz" 48, "SOFT" 60;
  letter-spacing: -0.016em;
}
${G} .VOzbGW_navCell { border-radius: 10px; transition: background-color .16s var(--kh-ease); }
${G} .VOzbGW_navCell.VOzbGW_active {
  font-weight: 500;
  background: var(--kh-chip);
  box-shadow: var(--kh-rim), 0 1px 2px var(--kh-shade);
}
${G} .VOzbGW_navCell.VOzbGW_active svg { color: var(--dsw-alias-link); }
${G} .VOzbGW_close { border-radius: 999px; }

/* ── The conversation ── */
${G} .wSkVaW_crumbCurrent { font-weight: 560; letter-spacing: -0.011em; }
/* Chat and Trajectory: a segmented control instead of underlines */
${G} .wSkVaW_viewTabs {
  display: flex;
  gap: 2px;
  padding: 3px;
  border-radius: 12px;
  background: var(--kh-well);
  box-shadow: inset 0 0 0 .5px var(--kh-edge);
}
${G} .wSkVaW_tab {
  min-height: 26px;
  padding: 0 12px;
  border-radius: 9px;
  color: var(--dsw-alias-label-secondary);
  transition: color .16s var(--kh-ease), background-color .16s var(--kh-ease);
}
${G} .wSkVaW_tab:hover { color: var(--dsw-alias-label-primary); }
${G} .wSkVaW_tab::after { display: none; }
${G} .wSkVaW_tabActive {
  color: var(--dsw-alias-label-primary);
  background: var(--kh-chip);
  box-shadow: var(--kh-rim), 0 1px 2px var(--kh-shade);
}
/* The person's message: a teal-dyed pane, its corner turned toward them */
${G} .Sixlwa_bubble {
  border-radius: 20px 20px 6px 20px;
  box-shadow: var(--kh-bubble-rim);
}
${G} .xzv4MW_timeStart { font-variant-numeric: tabular-nums; }

/* The agent at work: a running stitch in saffron thread instead of
   DeepSeek's whale */
${G} .EvIC1a_runningWhaleAnimated,
${G} .EvIC1a_runningWhaleStill { display: none !important; }
${G} .EvIC1a_runningIcon::before {
  content: "";
  position: absolute;
  inset: calc(50% - 1px) 0;
  border-radius: 1px;
  background: repeating-linear-gradient(90deg, currentColor 0 3px, transparent 3px 5.5px);
  -webkit-mask: linear-gradient(90deg, transparent, #000 25%, #000 75%, transparent);
  mask: linear-gradient(90deg, transparent, #000 25%, #000 75%, transparent);
}

/* ── The start screen ── */
${G} .kh-hero::before {
  content: "";
  position: absolute;
  z-index: -1;
  top: -56px;
  left: 50%;
  width: min(440px, 100%);
  height: 260px;
  transform: translateX(-50%);
  pointer-events: none;
  background: radial-gradient(closest-side, var(--kh-halo), transparent);
}

@media (prefers-reduced-motion: no-preference) {
  ${G} .EvIC1a_runningIcon::before { animation: kh-running 0.7s linear infinite; }
  ${G} .hHd-Xa_root:not(.hHd-Xa_collapsed) .hHd-Xa_newSession:active { transform: scale(.985); }
}
@keyframes kh-running { to { background-position: 5.5px 0; } }

/* Solid panes where transparency is turned down or glass isn't drawn */
@media (prefers-reduced-transparency: reduce) {
  ${G} body {
    --kh-glass: var(--dsw-alias-bg-layer-1) !important;
    --kh-glass-thick: var(--dsw-alias-bg-layer-2) !important;
    --kh-blur: none !important;
  }
}
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  ${G} body {
    --kh-glass: var(--dsw-alias-bg-layer-1) !important;
    --kh-glass-thick: var(--dsw-alias-bg-layer-2) !important;
  }
}
@media (prefers-contrast: more) {
  ${G} body { --kh-edge: var(--dsw-alias-border-l4) !important; }
  ${panes("::before")} { box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l4); }
}
`

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
  position: relative;
  isolation: isolate;
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
${GLASS_CSS}
`

    function installStyles() {
      const tag = document.createElement("style")
      tag.dataset.plugin = PLUGIN
      tag.textContent = CSS
      document.head.appendChild(tag)
      document.documentElement.dataset.khGlass = ""
      return () => {
        tag.remove()
        delete document.documentElement.dataset.khGlass
      }
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
