# 0010 — Charts in decks

- Status: accepted
- Date: 2026-08-01

## Context

`presentations/` now holds a Slidev theme and a deck template. The template's `image-right` slide
carries a placeholder SVG, and the first deck delivered off this theme shipped with that placeholder
still in it, because the real figures were not measured yet. The next deck will want a real chart,
and that raises a question the theme has never answered: where does a chart come from.

The deck is not a dashboard, and the constraints are not the web app's.

A deck presents with no network. Fonts are self-hosted through `@fontsource` for exactly this reason,
so anything a chart depends on has to be bundled into the deck's own build.

A deck exports to PDF. Canvas output rasterizes at export and at any zoom the room does not control;
SVG stays vector. The same slide is cast to a TV, screenshared, and read off a printout.

Every colour in the theme is measured. `tests/contrast_test.ts` enforces the token sheet, and
DESIGN.md's fill-only rule says washes are fills and never strokes or glyphs, with extra chart
categories coming from hachure angle and density rather than from promoting a wash to a line colour.
A charting library that ships its own categorical palette walks straight past all of that.

The theme is Vue 3 under Slidev. The web app, by [0009](0009-scope-boundaries.md), stays vanilla ES
modules and hand-writes its one piece of SVG (`web/roadmap.js` emits the dependency edges as a
string). Nothing in the repo has ever taken a charting dependency.

## Decision

No charting library is wired in. Decks keep using static SVG committed under the deck's `public/`,
and the template ships a small placeholder that says so on its face.

When a deck needs a chart that is generated rather than drawn, the first thing to try is
[TanStack Charts](https://tanstack.com/charts/latest) through its Vue adapter, behind a theme
component that takes its colours from `styles/tokens.css`. It is not adopted today because it is
pre-alpha at 0.4.0 and its own documentation says the API may change between releases and that it is
not ready for production. A talk is a hard deadline; a chart library that changes shape between the
draft and the room is a bad trade for a deck that could have shipped an exported SVG.

It is nonetheless the right one to try first when that changes. It is MIT, its core is
framework-neutral with the Vue binding as an adapter rather than a rewrite, it renders accessible SVG
by default with Canvas as an opt-in rather than the only surface, and it keeps D3 and state ownership
explicit instead of hiding them behind a chart component. That last point is what matters here: the
theme has to own the marks and the colours, and a library that hands back a finished chart cannot be
made to obey the two-scale pen rule.

Revisit when TanStack Charts leaves pre-alpha, or sooner if a deck needs a chart that static SVG
genuinely cannot express (live data during the talk, or a series the presenter changes in the room).

## Alternatives considered

**Static SVG, exported from wherever the analysis already lives.** What the theme does today. Costs
nothing, adds no dependency, survives the PDF export perfectly, and the file can be hand-edited to
take the theme's pens. It fails only when the data is not final, which is exactly the case that
produced a placeholder in the first deck. This stays the default.

**Hand-written SVG in the slide**, the way `web/roadmap.js` writes its edges. Free, fully under the
theme's control, and already a pattern in this repo. Fine for a five-point line or a bar comparison,
and it does not scale past that: axes, ticks, and scales are the part nobody wants to write twice.

**roughjs, which the theme already depends on.** The tempting one, because it would make a chart look
like the rest of the deck rather than like an import. Rejected as the general answer: roughjs draws
shapes, so this is the hand-written-SVG option with a wobble filter and all of its scale problems
intact. It remains the right renderer for a chart the theme eventually does grow, layered on top of
whatever computes the scales.

**Observable Plot.** The closest thing to a concise grammar that is not pre-alpha, SVG by default and
framework-neutral, at 83–92 KiB against TanStack's 26–32. Its defaults are opinionated in a way that
fights a measured palette, and its output is a finished figure rather than composable marks, which is
the same objection as any chart-component library.

**Chart.js.** Canvas only. That alone disqualifies it for a deck that exports to PDF and gets cast to
a TV.

**Apache ECharts.** Can render SVG, and at 153–173 KiB it brings a dashboard's worth of machinery to
a slide with one line on it.

**Recharts.** React-only. The theme is Vue.

**D3 directly.** What every option above is built on, and the honest answer for an arbitrary custom
figure, at the cost of writing the scales and axes by hand every time. If a deck ever needs one
bespoke chart and nothing else, this is cheaper than adopting a library for it.

## Consequences

- The template keeps a placeholder that reads as a placeholder, so a deck cannot quietly present one
  as a finding, which is the failure mode the first deck came closest to
- A deck with real data pays an export step from wherever the analysis lives, and there is no path to
  a chart that updates itself during a talk
- Adopting TanStack Charts later means writing a theme component and extending
  `tests/contrast_test.ts` to cover whatever colours the chart introduces, not just dropping the
  library in
- The repo still takes no charting dependency, so [0009](0009-scope-boundaries.md)'s no-vendored-assets
  position holds for the web app and the presentations directory alike
