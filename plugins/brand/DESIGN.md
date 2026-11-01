# Kriya Harness: design

The Web UI is DeepSeek Harness's, dressed as Kriya through the seams it
offers other identities: theme token overrides (`ctx.theme.overrideTokens`),
the brand slots, and plugin-owned styles. Layout and behaviour stay DSH's;
nothing in DSH is edited.

## Subject

Kriya Harness is your Kriya agent working in a folder on your own machine.
The people using it build things: they give the agent a job, watch it read,
edit and run, and approve what it asks. Long sessions, mostly reading.
"Kriya" means action, and Kriya's mark is stitched: on Tavi, the mascot, the
K is embroidered thread with a terracotta leaf where its strokes meet.

## The one memorable thing

The start screen stitches the K. Before the first message, the mark is drawn
as a running stitch in saffron thread, then fills in, then the question
appears under it. It plays once per page load and never moves again
(reduced motion: drawn complete). Everything else stays quiet so this lands.

## Colour

Kriya's own palette (the Kriya app's `app/globals.css`), mapped onto DSH's
tokens. Teal is action (buttons, links, focus); saffron is the thread and
the agent at work; the leaf appears only in the mark.

| Name | Light | Dark | Used for |
| --- | --- | --- | --- |
| Paper | `#F3EEE6` | `#0A1213` | Main background |
| Leaf-sheet | `#FBF8F3` | `#122021` | Raised surfaces, composer, menus |
| Loom | `#EAE3D7` | `#071011` | Sidebar column |
| Ink | `#13292B` | `#F2EADF` | Text |
| Teal | `#1F6362` | `#6CC0B8` | Action, links, focus ring, selection |
| Saffron | `#B4622F` | `#E7A46D` | Thread, agent activity, warnings |

Secondary text, borders and hover fills are Ink at fixed opacities, so they
sit on either paper without new hues. Success and error keep their meaning
(`#2C8A5F`/`#6FD3A0`, `#C2413A`/`#F07A6E`, Kriya's own).

## Type

- **Geist** (variable): interface and conversation text. A plain, technical
  grotesk for a tool read for hours; different from both DSH's system stack
  and the Kriya app's Inter, so the harness is recognisably its own room in
  the same house.
- **Fraunces** (variable, soft optical sizes): the start-screen question
  and the sidebar name. Kriya's display face. Replies keep Geist headings:
  DSH sets them through shorthand font tokens with computed sizes, which a
  family override can't touch safely.
- **JetBrains Mono**: code, diffs, the terminal. Kriya's code face.

Fonts are embedded in the plugin (the UI works offline on 127.0.0.1); a font
chosen in Settings still takes precedence over these.

## Rules

- No all-caps labels, no monospace for labels, no decorative gradients.
- One motion moment (the stitch). Interface motion stays DSH's.
- Contrast: body text at least 7:1 on Paper in both schemes; secondary text
  at least 4.5:1.
- Copy is plain and says what is true: what runs where, what costs what.
