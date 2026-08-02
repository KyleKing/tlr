# Presentations

Everything needed to build a short internal decision talk: a Slidev theme, a starter deck,
and the process notes from the first one that shipped.

```
presentations/
  slidev-theme-roughdraft/   the theme (layouts, components, tokens, high-contrast mode)
  template/                  the starter deck deno task deck new copies
  decks/                     your decks, one directory each (gitignored by default)
```

## Making a deck

```sh
deno task deck new q3-triage     # copies the template into presentations/decks/q3-triage
deno task deck dev q3-triage     # npm install on first run, then the Slidev dev server
deno task deck build q3-triage   # static build into the deck's dist/
deno task deck export q3-triage  # PDF
deno task deck list
```

Decks are npm/Vite, not Deno. `hk.pkl` and `deno.json` both exclude `presentations/`, so nothing
in here is type-checked or linted by the repo's Deno tooling. That is deliberate: the theme uses
browser globals and npm bare specifiers that Deno cannot resolve.

## The checklist

Written after delivering the first deck. Following it is faster than rediscovering it.

1. Write the content first in plain markdown, one claim per headline, before touching a layout
2. Pick the layout per slide from the ten in the theme README rather than forcing `default`
3. Take `--rd-pen-{name}-ink` for anything that is text, `--rd-pen-{name}` for strokes, and washes for fills only
4. Give every rough shape its own stable `seed` string
5. Spend violet at most once per slide
6. Screenshot the whole deck once, fix in one batch, confirm once, then stop
7. Check `c` (high contrast) actually reads before walking into an unfamiliar room
8. Re-measure any token pair whose background changed

That last one is automated. `tests/contrast_test.ts` fails the build when any text or stroke role in
`styles/tokens.css` drops below its threshold in either palette, and `deno task contrast` prints the
whole table with the margin on each pair. Both read the token sheet directly, so a colour cannot be
changed without being measured. The pairs and their thresholds live in `src/contrast.ts`; a new
colour earns its place there by measurement.

## Footguns

Five things that cost time on the first build and will recur.

Component names collide with Slidev's built-ins silently. A component named `Arrow` is shadowed by
Slidev's own `Arrow`, renders nothing useful, and only warns in the console. Check
`node_modules/@slidev/client/builtin/` before naming a component.

roughjs reads its canvas size from the SVG's `width` and `height` attributes, not from CSS layout.
Without them every shape fails with a NaN warning and draws nothing.

`unplugin-vue-components` caches the component list at dev-server start, so renaming a component
needs a restart. A hot reload leaves you debugging a component that resolves fine on disk.

Auto-import does not apply inside the theme's own components. A theme component using a sibling
theme component has to import it explicitly.

Slidev ships no default shortcut for drawing. The theme binds `p` in `setup/shortcuts.ts`. `d` is
Slidev's dark-mode toggle, so a speaker note that says "press d to draw" flips the theme in front
of the room.

## Charts

The template ships a placeholder SVG. [ADR 0010](../adr/0010-charts-in-decks.md) covers what to
reach for when a deck needs a real one, and why nothing is wired in yet.
