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
appears under it, all in a soft pool of light (`--kh-halo`). It plays once
per page load and never moves again (reduced motion: drawn complete).
Everything else stays quiet so this lands.

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

## Material: glass over cloth

The interface is panes of tinted glass floating over a lit ground. The
colours above stay exactly as they are; the material changes what the
surfaces are made of, not their hue.

- **The ground.** Paper with a fine grain, lit by two faint lights: teal
  from the top (`--kh-ground-a`, 12 % light / 10 % dark) and saffron warmth
  from the bottom right (`--kh-ground-b`, 9 % / 6 %). It is the only
  gradient, and it is light, never decoration on text or controls.
- **Panes.** The sidebar floats inset from the window edges as a thin
  pane (`--kh-glass`); the composer, the approval card and Settings are
  thick panes (`--kh-glass-thick`), because text is typed or read there.
  Each pane blurs what's behind it (`--kh-blur`), catches light on its top
  edge with a hairline around it (`--kh-rim`) and floats on a soft
  shadow (`--kh-lift`, `--kh-lift-high` for dialogs). DSH's menus and every
  other DSH elevation share the same lift.
- **Wells and chips.** Things below a pane (the Settings nav, the Chat and
  Trajectory control, a disabled send) sit in a well (`--kh-well`);
  selected things sit on it as a raised chip with the same rim
  (`--kh-chip`): the active session, the active Settings section, the
  active tab, New Session.
- **Focus and waiting.** The composer lights teal while it has focus (an
  edge and a 4 px halo); an approval waits edged in saffron the same way.
- **The person's message** is a teal-dyed pane with its bottom-right corner
  turned toward them.
- **The agent at work** is a running stitch moving through saffron thread,
  in place of DeepSeek's whale.

How it is built: every pane draws its glass on a `::before` behind its
content, never on the pane itself, because a `backdrop-filter` on the pane
would trap DSH's `position: fixed` children. Rules sit under
`html[data-kh-glass]`, set while the brand's styles are installed, so they
outrank DSH's own whatever order stylesheets load in. The DSH classes they
name are hashed per DSH build; `tests/brand.test.js` fails when the pinned
DSH loses any of them.

Fallbacks: with reduced transparency, or where `backdrop-filter` isn't
drawn, panes turn solid (Sheet, Leaf-sheet). With more contrast, every pane
gets a solid 1 px edge.

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

- No all-caps labels, no monospace for labels. The only gradients are the
  ground's light and the halo behind the start screen's K.
- One signature motion (the stitch). Beyond it, only feedback: hover and
  focus ease in over 160–240 ms, a pressed send or New Session gives a
  little; none of it plays with reduced motion.
- Contrast: body text at least 7:1 on Paper in both schemes; secondary text
  at least 4.5:1, also on every glass pane laid over every part of the
  ground (tested).
- Layout and behaviour stay DSH's: the material never moves, hides or
  resizes DSH's controls (its only removal is the scroll fade painted in
  the old solid sidebar colour).
- Copy is plain and says what is true: what runs where, what costs what.
