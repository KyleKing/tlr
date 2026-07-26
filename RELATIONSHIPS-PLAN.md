# Relationships view: a redesign of the roadmap plane

Status: proposal. Nothing here is built.

## What exists

`/roadmap` puts every ticket on one pannable plane. X is an ordinal time bucket (cycle, else
milestone, else Backlog), spaced evenly rather than by date. Y is dependency wave depth from a Kahn
peel over the blocking graph. Cards are fixed 150x46 divs positioned absolutely, edges are cubic
béziers in one SVG overlay with no routing and no bundling, and pan/zoom is a CSS transform on the
plane. `web/lib/roadmap.js` holds the layout as pure logic, `web/roadmap.js` holds the interaction,
and `tests/roadmap_test.ts` drives the layout directly.

## What is wrong with it, from first principles

The plane asks one axis to carry two meanings at once. X is time, but the arrows drawn across it mean
dependency, which is also time. When a blocker sits in a later bucket than its dependent the edge
points backward and gets dashed and reddened. That measure fired zero times across 25 real edges, so
the axis conflict produces no information and costs a whole visual vocabulary.

Row bands are sized by the widest cell across every column at that depth. One crowded Backlog cell
inflates the row for all columns, so the plane is mostly empty space whose size is set by the worst
cell rather than by anything a reader cares about.

Card size is constant. Estimate, the one quantity the project actually has for 55 of 66 issues, is
printed as a number instead of being encoded. ADR 0002's second objective asks for the opposite:
encode load with position and fill, not repeated numbers.

Filters run before layout, so hiding a status re-derives waves and re-packs lanes. The plane
describes the visible set rather than the project, and positions move under you as you filter.

Edges are drawn without routing. At real density they overlap into noise, which is the complaint that
started this.

## The prior verdict, and why this is different

`ROADMAP.md` records a node/edge relationship page that was spiked against the real project and
deleted. Of 77 open issues only 31 sat in any blocking chain, and 6 of 7 clusters were pairs or
triples. The conclusion was that the drawing added nothing over the wave plane, that the text beside
each cluster was what carried information, and that a dedicated graph page stays unbuilt unless a
project turns up whose graph is too dense for the wave plane. ADR 0002 reaches the same place from
the other direction: a dependency DAG is a later companion view because relations are thin.

That verdict was measured on blocking edges alone. Blocking is sparse by nature, because someone has
to type each edge. Similarity is dense by construction: every pair of tickets has a score, and the
interesting ones are a property of the text, not of anyone's bookkeeping. Adding similarity is the
density condition the prior note named, so this proposal clears its own revisit bar rather than
overruling it. If it ships, both `ROADMAP.md` and ADR 0002 should be amended to say so.

## The design

One plane, one set of cards, four layouts. A layout is a pure function of the snapshot returning
positions, so it lives in `web/lib/` and is testable in Deno with no DOM, exactly as
`roadmapLayout` is today.

```
layout(snapshot, options) -> { nodes: [{ id, x, y, w, h }], edges, groups, width, height }
```

Everything outside the layout is shared and does not change when you toggle: the filter bar, the
search, the selection, the detail card, the keyboard model, and the pan/zoom state.

### Sequence (blocking)

A layered DAG. X is wave depth, so an arrow always points right and direction is readable without
color. Y is a lane assigned by a median/barycenter sweep to reduce crossings, run two or three passes
and then straightened. Time drops out of the axes and becomes a label and a tint, which costs nothing
because the backward-edge measure it enabled never fired.

Layer heights are local to the layer instead of global to the depth, which removes the empty-band
problem.

### Similarity

Distance is the message and there are no edges by default. Build the pairwise distance matrix as
`1 - score`, run classical MDS (double-center, top two eigenvectors by power iteration) for the
projection, then a few deterministic overlap-removal passes so cards do not collide. At 200 nodes the
matrix is 40,000 floats and the projection is a few milliseconds, and it is fully deterministic, which
matters twice: tests can assert positions, and a ticket stays where you last saw it.

Edges appear only for pairs above the confidence band, and only for the selected ticket's neighbors.
The default reading is spatial.

### Grouping

Milestone, cycle, parent, label, or assignee, picked from a dropdown. Groups are squarified treemap
boxes sized by ticket count (or by points), with cards packed in a grid inside each box. Distance
means same group, which is the most literal possible mapping and needs no legend.

`parentId` and `labels` are both fetched and stored today and read by nothing, so parent and label
grouping cost only the layout.

### Schedule

The current plane, kept as-is. It is what ships, the e2e suite locks it, and bucket-against-wave is
still the right answer when the question is scheduling rather than structure.

### Card size

Height (or area) encodes remaining estimate, floored so a 1-point card stays legible and clamped so a
13-point card does not dominate. This is ADR 0002's own objective applied to the plane it was written
for, and it makes the heavy spine of a chain visible without reading a single number.

### Card detail, and how much shows by default

Three levels, driven by an explicit toggle and by zoom, so the plane can be read at 200 nodes without
becoming either a wall of text or a field of anonymous boxes.

- L0, tile: the card is a sized, tinted rectangle with no text. Reached by zooming out past roughly
  0.6, or by the Compact toggle. Shape, color, and position still carry estimate, status, and
  grouping, so a zoomed-out plane is a real reading rather than a placeholder
- L1, identity: id, points, and flag badges. The current roadmap card, minus the title
- L2, default: id, points, flags, a two-line title, assignee, and milestone. This is the resting
  state, because the stated job is understanding a project you do not have memorized, and an id alone
  does not serve that

The control is the same `Expand` / `Compact` label-toggle chip the board already uses, so the
vocabulary carries over and `DESIGN.md`'s label-toggle rule applies (the label names the state, so it
keeps the resting fill rather than taking the accent). Zoom moves the level automatically, and the
toggle pins it.

Titles are the only thing that changes width, so cards stay a fixed width at every level and only
height varies. That keeps the layouts stable when the level changes and means a level change never
triggers a re-layout.

### Transitions

Re-layout per relationship only works if you can follow a card from one arrangement to the next.
Without a transition, a toggle is a hard cut and spatial memory resets every time. This is the first
case in the product where motion carries information rather than decoration, and `DESIGN.md` records
motion as an open question rather than a prohibition. Proposal: a single position tween of about
300ms on mode change, nothing else animated anywhere, and a `prefers-reduced-motion` block that
reduces it to a cut. If that is not acceptable, the fallback is to keep the cut and rely on a brief
persistent highlight of the previously selected card.

## Data we need

Free, already fetched and stored, currently read by nothing:

- `parentId`, for parent grouping and for collapsing sub-issues into their parent
- `labels`, for label grouping and as a cheap structural similarity channel

One-line ingest fix:

- `related` is fetched from Linear (`relations(first: 20)`) and then discarded, because
  `transformIssue` only branches on `blocks` and `blocked`. It survives in seed data and the hover
  card reads it, so on real ingests that line is always empty. Keeping it gives a hand-curated
  relationship channel for free

New, and the only real cost:

- A sparse similarity list. Top-k neighbors per issue rather than a full matrix, so 200 issues at
  k=10 is about 2000 rows before deduplication

```
{ a: "SEED-125", b: "SEED-126", score: 0.81, why: "shares matchmaking, scoring · both M1" }
```

Sparse top-k rather than a dense matrix because the view only ever draws the top neighbors, the
snapshot is a JSON blob that gets stored per capture, and a dense 80x80 float matrix per capture
would bloat the store for values nothing reads.

Nothing else. No per-issue dates are fetched today and none are needed, which keeps ADR 0002's
rejection of a date Gantt intact.

## Similarity: where it comes from

The duplicates work is not in this repo. `DUPLICATES-PLAN.md` and `DUPLICATES-NOTES.md` are here, the
`spike/` directory is gitignored and absent from this machine, `verdicts.jsonl` is 0 bytes, and stages
S4 through S7 are unbuilt and waiting on a local llama.cpp runtime. So the view cannot depend on it
existing.

Proposal, following ADR 0007's port rule:

```
SimilaritySource (port)
  neighbors(issueId, k) -> [{ id, score, why }]
```

Two adapters. A structural one that ships now, scoring shared labels, shared parent, shared
milestone, co-blocking, and a lexical title/description overlap, all deterministic and testable with
no model and no network. And the real one that reads cached vectors and fused BM25F scores from the
duplicates engine once it lands.

The view never learns which adapter ran. That means the Similarity layout is useful on day one and
gets better without a rewrite, and it keeps the CLI deterministic, which `deno task cli` requires.

Worth noting from the notes: the duplicates work measured recall@1 at 36.6% and adjudicated 215
candidates into 18 DUP against 118 RELATED. For finding true duplicates that is a weak signal. For
laying out a map where distance means "these are about the same area of the code" it is a strong one,
because RELATED is exactly what the layout wants to show. The objective that failed there is the one
this view does not need.

## Use cases this supports

The stated job is orientation: can I understand this project at all.

- New to a project, or back after two weeks. Open in Grouping by milestone to learn the shape, switch
  to Similarity to see which clumps of work are actually the same effort under different milestones
- Is this ticket already covered. Select it, switch to Similarity, read the nearest neighbors
- What has to happen first. Sequence, filtered to one milestone
- Why is M2 late. Sequence plus the existing chain list, which the prior spike found was the part
  that carried information
- Before filing a batch. Select the drafts and see whether they land as one cluster or several

## Scale, and why not canvas

Working range: around 100 tickets for a project near completion, up to about 200 in triage after light
filtering. Call 250 the design ceiling.

DOM cards plus one SVG edge overlay holds comfortably at 250, and canvas is the wrong trade until
roughly 1000. The reasons are specific rather than general:

- 250 absolutely positioned divs is not a rendering problem. Pan and zoom are one CSS transform on the
  parent, which the compositor handles on the GPU without touching layout, so frame cost is flat in
  node count. This is already how the current plane works
- Edge count stays low by design. Blocking edges are sparse (25 across the real project) and
  similarity edges only draw for the selected ticket's neighbors, so the SVG carries tens of paths,
  not thousands. If a mode ever wants all-pairs edges at once, that specific overlay can move to a
  canvas layer underneath the DOM cards without touching anything else
- Canvas costs the things this product has committed to. Keyboard focus, roving tabindex, `aria`
  state, and the axe contrast scans all work because cards are real elements. On canvas every one of
  those is hand-rolled, and `PRODUCT.md` records keyboard navigation as first-class rather than a
  fallback. That is a large, permanent bill for a frame budget we are not exceeding
- Text rendering on canvas at 11-13px means either bitmap fonts or blurry labels at fractional zoom,
  and the whole L2 default depends on readable small text

The real performance work at 250 is not the renderer, it is that `render()` currently wipes
`plane.innerHTML` and rebuilds every card on every filter keystroke. That is what will feel slow, and
it is slow at any node count. The fix is a keyed update that reuses existing card elements and only
writes changed positions and classes, which is worth doing regardless of this redesign.

The trigger to revisit: sustained frames over 16ms while panning with all modes at full filter, or a
mode that genuinely needs every edge drawn at once. Measure before switching.

## What this breaks

- `tests/e2e/pages.spec.ts` asserts `#summary` contains the literal "dependency waves", that
  `.rm-row-label` count is greater than 1, and that no two cards share an offset. The first two are
  Schedule-mode facts and need to move behind the mode
- `a11y.spec.ts` scans `/roadmap` with a status chip pressed. New modes need their own scans
- `--muted` is referenced by `.rm-chain-dim` and nine other places and is defined by no theme, so
  those elements inherit `--text` and pass contrast by accident. Any repaint of the roadmap has to fix
  it rather than inherit the accident

## Non-goals

- No date Gantt. ADR 0002 rejected it on measurement (1 of 66 issues has a due date) and nothing here
  changes that
- No graph library. ADR 0009 rules out a framework, a build step, a CDN, and vendored assets, so every
  layout is hand-written pure JS in `web/lib/`
- No cross-project view, per ADR 0009
- No canvas or WebGL at this scale. The reasoning is below, because it is a real call rather than a
  preference

## What the prototype showed

Built at `web/proto/relationships.html` (served by `deno task dev`) over 180 synthetic tickets across
seven themes, because the shipped seed has 34 issues, 8 edges, no labels, and no parents. Three
directions were driven in the browser: A Atlas (every edge always drawn), B Focus (no containers,
edges and neighbourhood only on selection), C Strata (banded groups, edges only where direction
matters).

**A reproduces the original complaint exactly.** In Similarity mode it draws 387 edges over 180
cards and they carry no information, because position already says what the edge says. Two things
occupying the same channel is what made the old plane messy, and drawing similarity as lines repeats
the mistake in a new place.

**B is decisively right for Similarity.** Selecting one ticket drops the drawing from 387 edges to 3,
lights 7 neighbours, and dims the other 172. The neighbourhood becomes readable instantly, and the
neighbours are semantically correct: selecting "Mark message on the mobile path" surfaced "Mark thread
on the chat path", "Batch socket on the chat path", and "Route sync on the mobile path". Its weakness
is that it says nothing until you click, so it is a poor first impression on its own.

**C is right for Grouping.** Bands are more compact than the treemap (no dead space inside an
over-sized region), they scan top to bottom like the rest of the product, and varying card height
against a flat band makes estimate readable at a glance.

So the answer is not one direction globally. Edges earn their place only where they carry direction
that position cannot, which is Sequence alone. Recommended pairing: B's interaction model (edges and
emphasis on demand) as the global default, C's banding for Grouping, and A dropped.

Measured while building:

- The structural similarity adapter works on synthetic data: same-theme mean 0.484 against
  cross-theme 0.017, a 28x separation
- Straight `1 - similarity` MDS is unusable. Half of all pairs score exactly zero, so distances are
  near-constant and the plane collapses first to a blob and then to a line. Geodesic distance over the
  kNN graph plus SMACOF stress majorization produces the seven clusters cleanly, and both are
  deterministic
- Detail level must not change card box size. When it did, fit-to-content and auto-detail chased each
  other and never settled. Box geometry fixed, level changes only the contents, and the loop is gone
- 180 DOM cards with 387 live SVG edges pans and zooms without a dropped frame, which supports the
  no-canvas call above

## Open decisions

- Whether the 300ms mode transition is acceptable, given that the stylesheet has no motion at all today
- Whether Schedule stays a fourth mode or retires once Sequence and Grouping cover it
- Whether similarity is computed at refresh time and stored in the snapshot, or computed on demand in
  the browser. Storing it makes captures diffable and the CLI able to report on it; computing it live
  keeps the snapshot thin
