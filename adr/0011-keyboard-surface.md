# 0011 — Keyboard surface and the operator log

- Status: accepted
- Date: 2026-08-01

## Context

[PRODUCT.md](../PRODUCT.md) calls keyboard navigation first-class and leaves the mechanism open,
naming a command palette and vim-style bindings as candidates. Meanwhile the app has been growing
bindings without a rule:

- The board grid moves focus with arrow keys, opens a ticket on Enter or Space, and toggles reviewed
  on `s` (`onGridKey` in `web/app.js`)
- The roadmap pans with the same arrow keys, triples the step with Shift, zooms on `+`/`-`, resets on
  `0`, and gives cards their own Enter and Escape (`web/roadmap.js`)
- Escape closes popovers on every page

None of it is written down and none of it is visible on screen, so a binding is only found by trying
it. The `s` toggle in particular does real work and nothing announces it.

The `shoal/dev_boards` merge app ([0010](0010-work-states-and-the-shelf.md) has the wider model)
answered the same question years earlier, in a TUI: a row cursor over a table, `j`/`k` to move,
single-letter verbs acting on the row under the cursor, and a footer that renders the current
bindings. Bindings hung on the widget rather than the app, so the same key meant different things on
different tables and the footer changed with focus.

That shape suits tlr better than a palette. A palette is for a wide flat action space reached by
name; tlr's pages are dense tables where each row is one ticket with four or five verbs. It also
matches what the app already does by accident.

## Decision

### Bindings are scoped to the focused region, and the region owns them

A page does not hold one key map. Each region that takes focus (the board grid, a roadmap card, the
review list) declares its own, and Escape returns focus outward. Keys may be reused across regions.
Global bindings stay few and are reserved for things that mean the same everywhere.

### Every binding is listed on screen

A hint bar renders the bindings for whatever holds focus, updating as focus moves. A binding that is
not rendered does not exist, which is the rule that keeps this from drifting back to the current
state. This replaces a help modal: a modal is one more thing to discover, and the bar is the reason
the TUI needed no help screen.

### Verbs act on the focused row, and a write still previews

A single letter runs the verb against whatever the cursor is on. Anything reaching Linear opens the
same dry-run preview a click does, because [0009](0009-scope-boundaries.md) puts a person in front of
every write and a keystroke is easier to fire by accident than a click. The merge app merged a real
PR on one keypress; that part does not carry over.

### Vim keys are added alongside arrows, not in place of them

`j`/`k` and `h`/`l` where a region already moves a cursor with arrows. Arrow keys keep working, since
they are what a keyboard user who is not a vim user will reach for first.

### The run log is readable in the app

`src/runLog.ts` records every scheduled capture and `GET /api/schedule/health` reads it back, but the
only thing the UI does with it is banner a failed or overdue run. A scheduled capture has no terminal
attached, so when a run half-succeeds the detail is in a file the user has to go find.

A collapsed pane, toggled by a global binding, shows recent run entries with their outcome and
detail. It reads the endpoint that already exists and adds no new store. The dev-boards app docked
the same thing at the bottom of the screen behind a backtick.

## Consequences

- Adding a binding means adding it to the focused region's map and to the hint bar, or it is not
  shipped
- The hint bar is a fixed strip on dense pages, which costs vertical room that the board and roadmap
  do not have to spare
- Reusing keys across regions means a key can do two things on one page, which is only safe because
  focus is always visible
- Existing bindings need a pass to fit the model: `s` on the board is already row-scoped, and the
  roadmap's pan and zoom keys are viewport-scoped rather than row-scoped and stay that way
- The log pane makes a partial capture legible without a terminal, and it is another surface that can
  show real ticket titles, so it follows [0003](0003-local-data-public-repo.md) and never appears in
  a committed screenshot
