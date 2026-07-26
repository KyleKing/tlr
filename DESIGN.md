---
name: tlr
description: A capacity- and dependency-aware planning board for Linear, read at a glance
colors:
  base: "#1e1e2e"
  mantle: "#181825"
  crust: "#11111b"
  text: "#cdd6f4"
  subtext0: "#a6adc8"
  surface0: "#313244"
  surface1: "#45475a"
  mauve: "#cba6f7"
  blue: "#89b4fa"
  green: "#a6e3a1"
  peach: "#fab387"
  pink: "#f5c2e7"
  teal: "#94e2d5"
  lavender: "#b4befe"
  yellow: "#f9e2af"
  red: "#f38ba8"
  sky: "#89dceb"
  accent: "{colors.mauve}"
  accent-fg: "#111111"
  st-started: "{colors.blue}"
  st-unstarted: "{colors.subtext0}"
  st-triage: "{colors.yellow}"
  st-backlog: "{colors.surface1}"
  st-completed: "{colors.green}"
  st-canceled: "{colors.red}"
  risk: "{colors.peach}"
  slop: "{colors.pink}"
  miss: "{colors.red}"
typography:
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 650
    lineHeight: 1.5
    letterSpacing: "-0.01em"
  title:
    fontFamily: "{typography.headline.fontFamily}"
    fontSize: "13px"
    fontWeight: 650
    lineHeight: 1.5
    letterSpacing: "normal"
  body:
    fontFamily: "{typography.headline.fontFamily}"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "{typography.headline.fontFamily}"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "normal"
    letterSpacing: "normal"
  micro:
    fontFamily: "{typography.headline.fontFamily}"
    fontSize: "10.5px"
    fontWeight: 400
    lineHeight: "normal"
    letterSpacing: "normal"
  numeric:
    fontFamily: "ui-monospace, \"SF Mono\", Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "normal"
    fontFeature: "tabular-nums"
  brand:
    fontFamily: "{typography.headline.fontFamily}"
    fontSize: "13px"
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: "0.02em"
rounded:
  sm: "4px"
  md: "6px"
  lg: "10px"
  pill: "999px"
  circle: "50%"
spacing:
  hairline: "3px"
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
components:
  chip:
    backgroundColor: "{colors.mantle}"
    textColor: "{colors.subtext0}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "3px 10px"
  chip-pressed:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-fg}"
    rounded: "{rounded.md}"
    padding: "3px 10px"
  chip-mini:
    backgroundColor: "{colors.mantle}"
    textColor: "{colors.subtext0}"
    rounded: "{rounded.md}"
    padding: "2px 7px"
  pill:
    backgroundColor: "{colors.mantle}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "5px 11px"
  pill-pressed:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-fg}"
    rounded: "{rounded.md}"
    padding: "5px 11px"
  tick:
    backgroundColor: "{colors.base}"
    textColor: "{colors.text}"
    typography: "{typography.numeric}"
    rounded: "{rounded.pill}"
    padding: "1px 6px"
    height: "20px"
  card:
    backgroundColor: "{colors.mantle}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "4px 7px"
  badge:
    backgroundColor: "transparent"
    textColor: "{colors.risk}"
    typography: "{typography.micro}"
    rounded: "{rounded.pill}"
    padding: "0 5px"
  input-search:
    backgroundColor: "{colors.mantle}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "6px 10px"
    width: "230px"
---

# Design System: tlr

## Overview

**Creative North Star: "The Situation Board"**

tlr is a wall you stand in front of to find what is wrong. Every page puts the whole state of a
project into one view and then uses color, ring, and weight to pull your eye to the two or three
things that need you. The board is people against cycles, the roadmap is time against dependency
depth, the review queue is one row per ticket that moved. In each case the layout is spatial and
persistent, so the same problem shows up in the same place twice in a row and you learn where to
look.

Density is the point, not a compromise. Body text is 14px, most interface text is 11 to 13px, and
numbers are monospace with tabular figures so columns of points line up as columns. A lead opens
this for ninety seconds between meetings; anything that trades information per screen for comfort
takes the tool further from its job. The neutral field is deliberately flat and quiet so that the
handful of colored marks (a slop badge, a red chain-risk ring, a heat wash on an overloaded cell)
are the only things with any voice.

Color comes from Catppuccin, four flavors the user picks between, with the light flavor deliberately
darkened from stock so small text clears AA. The interactive accent is user-selectable across eight
hues; the status colors are not. That split is the whole color doctrine: the accent says "you chose
this", the status colors say "the data says this", and they must never be confused.

**Key Characteristics:**

- One screen holds the whole project; scanning replaces navigating
- Flat neutral field, 1px borders, color reserved for status and selection
- 11-13px interface type, monospace tabular numerals for anything countable
- Four user-selectable flavors and eight accents, all of them contrast-tested
- Rings and washes carry warnings, because they read at a distance and an underline does not

## Colors

A Catppuccin field of four near-neutral greys carrying a small set of saturated status hues, where a
saturated pixel always means something.

### Primary

- **Mauve** (`#cba6f7` mocha, `#8035e0` latte): the interactive accent. Selected chips and pills take
  it as a fill, focus rings take it as a 2-3px outline, active nav links take it as an underline, and
  every card carries it as a 3px left border. It is the only color the user can change, across eight
  hues (mauve, blue, green, peach, pink, teal, lavender, yellow). Latte's mauve is darkened from
  stock `#8839ef` so bold nav text clears 4.5:1 on `--mantle`

### Secondary

The status hues, fixed per flavor and never user-selectable. Each is exposed as a semantic token, and
UI should reference the semantic name rather than the hue.

- **Blue** (`#89b4fa`) as `--st-started`: work in progress
- **Green** (`#a6e3a1`) as `--st-completed`: done
- **Yellow** (`#f9e2af`) as `--st-triage`: needs a decision
- **Red** (`#f38ba8`) as `--st-canceled` and `--miss`: cancelled work, and missing data the plan
  depends on
- **Peach** (`#fab387`) as `--risk`: chain risk and forecast slip, the "this will land late" color
- **Pink** (`#f5c2e7`) as `--slop`: AI-tell detection on ticket text
- **Subtext0** (`#a6adc8`) as `--st-unstarted` and **Surface1** (`#45475a`) as `--st-backlog`: the two
  states that deliberately have no hue, because not-started is not a signal

### Neutral

- **Base** (`#1e1e2e`): the page field and the resting fill of a tick
- **Mantle** (`#181825`): every raised surface, which is to say chips, pills, cards, inputs, the nav
  bar, and table headers
- **Crust** (`#11111b`): past cycles and other de-emphasized cells, usually mixed rather than used neat
  (`color-mix(in srgb, var(--crust) 60%, var(--mantle))`)
- **Surface0** (`#313244`): table rules and dividers
- **Surface1** (`#45475a`): every 1px control border
- **Text** (`#cdd6f4`) and **Subtext0** (`#a6adc8`): primary and secondary type

### Named Rules

**The Two Vocabularies Rule.** The accent means "you selected this." A status hue means "the data
says this." A control may never be tinted with a status hue to look decorative, and a status may
never be drawn in the accent, because the accent changes per user and the meaning would change with
it.

**The Computed Foreground Rule.** Any text drawn on a solid status or accent fill uses that token's
computed `-fg` (`--accent-fg`, `--risk-fg`, and so on), never `--text` or `--base`. The accents span
dark mauve to pastel yellow across four flavors, and a fixed pairing goes unreadable on half of them.
`contrastFg()` picks the better of `#111111` and `#f5f5f5` by measured ratio.

**The Check-It-Where-It-Renders Rule.** A new color is checked against the background it will
actually sit on, in every flavor and accent pair, before it ships. `tests/theme_test.ts` sweeps the
matrix and `tests/e2e/a11y.spec.ts` runs axe color-contrast on eight scenarios. This repo has shipped
unreadable text more than once; the tests exist because judgment did not hold.

## Typography

**Body Font:** the system UI stack (`-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, `system-ui`)
**Label/Mono Font:** the system mono stack (`ui-monospace`, `SF Mono`, `Menlo`, `Consolas`)

**Character:** no webfont, no download, nothing vendored. The interface borrows the host OS's own
voice and spends its distinctiveness on layout and color instead. The mono face is not decorative;
it appears exactly where numbers must align.

### Hierarchy

- **Headline** (650, 18px, 1.5, -0.01em): the page title, one per page. The only type above body size
- **Title** (650, 13px, 1.5): table headers, section headers, and the person/bucket names that label a
  board axis
- **Body** (400, 14px, 1.5): table cells and prose
- **Label** (400, 12px): chips, popover buttons, and most controls
- **Micro** (400, 10-11px): badges, mini chips, and the secondary line under a card. The floor
- **Numeric** (600, 12px, mono, tabular-nums): ticks, point counts, estimates, anything a person will
  compare down a column
- **Brand** (700, 13px, 0.02em, accent-colored): the `tlr` wordmark in the nav, and nowhere else

### Named Rules

**The Tabular Numerals Rule.** Any number a reader might compare against the number above it gets
`font-variant-numeric: tabular-nums` and the mono stack. Points, estimates, day counts, and capacity
totals all qualify. A number embedded in a sentence does not.

**The 10px Floor Rule.** Nothing renders below 10px. Density is bought with tighter spacing and
shorter labels, never with smaller type.

## Layout

A full-bleed application shell, not a centered document. There is no max-width container: the board
and roadmap use the whole viewport because the whole viewport is the information.

Every page follows the same three-band structure. A 13px nav bar sits on `--mantle` with a
`--surface0` bottom rule. Below it a page head carries the 18px title, a one-line factual subtitle
(issue count, date range, data freshness), and a right-aligned escape action. Then a controls band of
chips and filters, a one-line summary of counts, and finally the artifact itself.

The spacing rhythm is tight and has six steps: 3px inside a cell, 4px between stacked cards, 6px
between chips in a group, 8px as the default gap, 12px between control groups, and 16px as page
padding. Page-level padding is 16px, cells are 5-6px, and controls are 2-6px vertical. There is no
8pt grid; the scale is the one the density needed.

Board and roadmap are grids of real table or absolutely positioned cells with 1px `--surface0` rules
and no outer border. Both are pannable and zoomable rather than paginated.

Responsive behavior is minimal and deliberate: two `max-width: 900px` breakpoints that stack the
controls band and let the page head wrap. Below that the board is still a wide scrollable grid,
because a capacity matrix does not have a phone layout. This is a desktop tool.

### Named Rules

**The Whole-State Rule.** A page shows the entire project by default and filters down. It never
paginates, because the question the tool exists to answer ("what is wrong") cannot be asked one page
at a time.

## Elevation & Depth

The system is flat by default and uses tonal layering rather than shadow: `--base` is the page,
`--mantle` is anything raised, `--crust` is anything pushed back, and a 1px `--surface1` border does
the work a shadow would do elsewhere. Shadows appear only where something genuinely floats above the
page, and they are large and soft rather than subtle.

Warnings do not use elevation at all. A ticket at risk gets a 2px ring drawn with `box-shadow: 0 0 0
2px`, and a field error gets a 1px inset ring, because a ring reads at a distance across a dense grid
where an underline or a tint does not.

Flatness is the rule. Motion is now part of the system, on two timings and one curve.

### Motion

- **`--dur-state`** (120ms): a control answering a pointer or a key. Border colour only, on chips,
  pills, and cards. Fast enough to read as response rather than as animation
- **`--dur-move`** (300ms): something changing where it is on the page, which needs long enough to
  follow with your eye. Re-layout between relationship modes is the case this exists for
- **`--ease`** (`cubic-bezier(0.4, 0, 0.2, 1)`): the only curve

`@media (prefers-reduced-motion: reduce)` sets both durations to `0ms` at the token, so honouring the
preference is automatic and no component has to remember it.

### Named Rules

**The Motion Follows Meaning Rule.** Animate only a property whose change carries information: a
state that answered you, or a position that moved. Never animate to decorate, never animate on load,
and never animate something the reader did not cause.

**The Never Animate Contrast Rule.** Never transition `color` or `background-color` on an element
carrying text. Latte is tuned to clear 4.5:1 by a hair, so interpolating between two passing colours
spends the whole margin and renders failing text for the length of the transition. Border, outline,
and shadow are the animatable channels, because none of them owes a contrast ratio. The axe spec
catches this: it sampled a chip mid-transition at 4.42:1.

### Shadow Vocabulary

- **Modal** (`0 20px 60px rgba(0, 0, 0, .28)`): the edit dialog, the only true overlay
- **Popover** (`0 8px 24px rgba(0, 0, 0, .22)`): multi-select dropdowns and hover cards
- **Floating control** (`0 4px 16px rgba(0, 0, 0, 0.2)`): controls pinned over the roadmap plane
- **Hover glow** (`0 0 0 2px color-mix(in srgb, var(--accent) 30%, transparent)`): a tick under the
  cursor
- **Warning ring** (`0 0 0 2px var(--red)` / `var(--peach)`): chain risk, slop, missing data
- **Inset error** (`inset 0 0 0 1px var(--red)`): an invalid field inside the edit modal

## Shapes

One radius does nearly everything: `--radius`, 6px, on chips, pills, cards, inputs, selects, and
panels. Two exceptions carry meaning. Anything countable and atomic (a tick, a badge) is a 999px
capsule, so a scannable count reads as a unit rather than a box. Avatars are circles.

Borders are always 1px and always `--surface1`, except for the 3px accent left border that marks a
card as a ticket and the 3px status left border that marks a roadmap card's state. Corners are never
square and never more than 10px, so the whole surface reads as one family at a glance.

## Components

**Character: intuitive, powerful, and composable.** A control should be obvious on sight, should do
the real thing rather than a simplified version of it, and should sit next to any other control
without either needing to know about the other.

### Chips (the primary control)

- **Style:** 1px `--surface1` border on `--mantle`, 6px radius, 3px/10px padding, 12px label. Text is
  `--subtext0` when off
- **State:** `aria-pressed` is the state, always. Pressed fills with `--accent`, takes `--accent-fg`
  text and the accent as its border, and goes to weight 600
- **Label toggles are the exception:** a chip whose label already names its state ("Rows: buckets",
  "Expand") keeps the resting fill when pressed, because the accent fill would say the same thing
  twice
- **Variants:** `.mini` (2px/7px, 11px) for in-cell chips, `.ghost` and `.danger` for modal actions

### Pills

The same object one size up (13.5px, 5px/11px) for a primary page-level toggle. Same pressed
treatment, focus ring at 2px offset instead of 1px.

### Ticks

The signature component: a 999px capsule, 20px tall, 600-weight 12px mono with tabular numerals, on
`--base` with a 1px border. One tick is one ticket in one board cell. Hover shifts the border to the
accent and adds the soft accent glow; warnings add a 2px colored ring; keyboard focus adds a 3px
solid accent outline at 2px offset and lifts the z-index so the ring is not clipped by a neighbor.

### Cards

Ticket cards on `--mantle`, 6px radius, 4px/7px padding, with a 3px accent left border that makes a
card identifiable as a ticket in peripheral vision. Inside: a 700-weight 11px mono id, a right-aligned
point count in `--subtext0`, and a title clamped to two lines at 1.35 line-height. Hover shifts the
border to the accent; the same warning rings apply.

### Badges

10px capsules with no fill and a `currentColor` 1px border, so the badge is drawn entirely in its
status hue. Used for slop, risk, and missing-data flags on a card.

### Inputs / Fields

`--mantle` fill, 1px `--surface1` border, 6px radius, 6px/10px padding, 13px. Placeholder is
`--subtext0`. Focus is a 2px `--accent` outline at 1px offset. Invalid fields in the edit modal take
a `0 0 0 2px var(--red)` ring plus an inset red line; warnings use peach in the same shape.

### Navigation

One fixed bar: the accent wordmark, six 600-weight 13px links, then a project picker and a demo tag
pushed right. The active link is marked by `aria-current="page"` and drawn with a 2px accent bottom
border. No dropdowns, no hamburger, no mobile variant.

### Heat

A capacity cell's load is a full-bleed absolutely positioned wash behind its contents at very low
alpha, with `pointer-events: none`. It tints the field rather than drawing a bar, so it survives being
read at a distance and never competes with the ticks on top of it.

### Edit Modal (signature)

A two-column dialog: fields on the left, an impact column on the right showing what the edit costs
(owner load before and after, milestone forecast movement, blockers and blocked work, a live slop
scan of the rewritten text). Backdrop plus the 20px/60px modal shadow. Preview is a dry run and the
confirm is a distinct action, because this is the only path in the product that writes to Linear.

## Do's and Don'ts

### Do:

- **Do** reference a semantic token (`--risk`, `--st-started`, `--slop`) rather than the hue behind
  it. The hue is an implementation detail of the flavor; the semantic name is the contract
- **Do** put every new color through `tests/theme_test.ts` and the axe contrast spec before shipping
  it, against the background it actually renders on, in all four flavors and all eight accents
- **Do** use `aria-pressed` as the source of truth for a toggle's state, and style from the attribute
  rather than a class
- **Do** use the mono stack with tabular numerals for any number a reader will compare vertically
- **Do** compute the foreground for text on a colored fill with `contrastFg()`, never hardcode it
- **Do** carry a warning as a ring (`box-shadow: 0 0 0 2px`), which is the established vocabulary and
  reads across a dense grid

### Don't:

- **Don't** tint a control with a status hue for decoration, or draw a status in the accent. The two
  color vocabularies are separate and the accent changes per user
- **Don't** go below 10px type, or add a font that has to be downloaded. Nothing is vendored and
  nothing loads from a CDN
- **Don't** introduce a max-width reading container on the board or roadmap. The artifact wants the
  whole viewport
- **Don't** paginate a project view. Filter it
- **Don't** add a shadow to a surface that does not actually float above the page; tonal layering
  plus a 1px border is how depth is expressed everywhere else
- **Don't** render a forecast as if it were a fact. Modeled landing dates, deflated capacity, and
  chain risk are labeled as estimates in the copy, not just in the color
- **Don't** transition `color` or `background-color` on an element carrying text. Animate border,
  outline, or shadow instead
