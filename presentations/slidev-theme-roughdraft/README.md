# slidev-theme-roughdraft

A Slidev theme for short internal decision talks. It reads like a well-labelled diagram
on a clean canvas: the hand-drawn quality comes from stroke geometry (roughjs draws the
boxes, rules, arrows, underlines, and circles), not from paper textures or sticky-note
props. Everything meant to be read is set in a high-legibility face at full ink.

Built for a room where engineers and non-engineers sit together, cast to a TV, and
argue with the slide instead of watching it.

## Using it

The theme is consumed from a sibling directory rather than a registry. `deno task
deck:new <name>` writes a deck under `presentations/decks/<name>/` already wired up;
to do it by hand, add:

```json
{
  "dependencies": {
    "slidev-theme-roughdraft": "file:../../slidev-theme-roughdraft"
  }
}
```

Then in your deck's frontmatter:

```yaml
---
theme: roughdraft
---
```

Fonts are self-hosted through `@fontsource`, so the deck presents with no network.
Do not set a `fonts.provider` in your deck; the theme pins `none` deliberately.

## Keys during a talk

| Key | Effect                                         |
| --- | ---------------------------------------------- |
| `p` | Toggle the pen and draw over the current slide |
| `c` | Toggle high-contrast delivery mode             |

High-contrast mode is for a washed-out room: pure black on white, strokes 1.4× heavier,
body and label type one step larger, and every pen colour pushed to its text-safe
variant. It persists in `localStorage`, so set it once before you walk in.

## Layouts

| Layout        | Use it for                          | Slots and frontmatter                                                   |
| ------------- | ----------------------------------- | ----------------------------------------------------------------------- |
| `cover`       | Opening slide                       | `meta:` list renders as a chip; `::note::` slot for a margin annotation |
| `section`     | Divider between acts                | `pen:` sets the accent (default `blue`)                                 |
| `default`     | Ordinary content                    | `::margin::` slot for a right-hand annotation                           |
| `statement`   | One claim, nothing else             | `::support::` slot beneath                                              |
| `two-cols`    | Four short labelled blocks          | `::title::`, `::left::`, `::right::`                                    |
| `diagram`     | Boxes and connectors                | `::title::`, default slot is the canvas, `::foot::`                     |
| `options`     | Comparing choices to decide between | `::title::`, default slot of `<Choice>` rows, `::foot::`                |
| `image-right` | A figure beside an argument         | `image:`, `alt:`, `caption:`; or the `::media::` slot                   |
| `board`       | Blank scratch space mid-discussion  | `prompt:` sets the question                                             |
| `end`         | Closing ask                         | `::asks::` slot for the decisions you need                              |

`board` is the only layout with a dot grid, which marks it as somewhere to draw.

## Components

Every `pen` prop takes `ink`, `quiet`, `blue`, `red`, or `violet`. Colour is semantic
here: red marks a correction or a problem, blue a caveat, violet the affirmative
(a recommendation, the option you picked). Never let colour be the only carrier of a
distinction. Spend violet at most once per slide; it stops meaning anything the second
time it appears.

`seed` keeps a shape's wobble stable across re-renders. Give each instance its own
string, or shapes will redraw differently on every paint and read as a glitch.

| Component    | What it draws                      | Key props                                                        |
| ------------ | ---------------------------------- | ---------------------------------------------------------------- |
| `RoughBox`   | Rounded box around its content     | `pen`, `seed`, `radius`, `weight`, `fill`                        |
| `RoughRule`  | Horizontal separator               | `pen`, `seed`, `weight`                                          |
| `RoughArrow` | Arrow with a hand-drawn head       | `dir`, `pen`, `seed`, `curve`, `weight`                          |
| `Mark`       | Emphasis on inline text            | `as` (`underline`, `circle`, `bracket`, `strike`), `pen`, `seed` |
| `Note`       | Margin annotation in the hand face | `pen`, `arrow`                                                   |
| `Figure`     | Oversized inline number            | `pen`, `circled`                                                 |
| `Choice`     | One row of an options comparison   | `name`, `cost`, `pen`, `pick`                                    |

`dir` accepts `right`, `left`, `up`, `down`, `down-right`, `down-left`. Vertical arrows
switch to a portrait box automatically.

Set `pick` on exactly one `Choice` to give the recommendation a box and more weight
than the alternatives it beat.

## Design notes worth knowing before you edit

Two colour scales exist for each pen. `--rd-pen-{name}` is tuned for 2px strokes;
`--rd-pen-{name}-ink` is the text-safe variant. Text always takes the `-ink` variant,
or it drops below 4.5:1 on the canvas. Every text role in both palettes measures AA or
better against its own background.

Type sizes live in `styles/tokens.css` and are absolute pixels in Slidev's 980×552
canvas space, not rem. When you add a step to the light palette, add it to the `.rd-hc`
block too, or the hierarchy compresses in the mode that needs it most.

Shantell Sans is the annotation voice only: notes, labels, `h3`, `h4`, blockquotes.
Body copy and emphasis stay in Atkinson Hyperlegible. Switching typeface mid-sentence
breaks the reading line.

Restraint is the point. The theme deliberately has no cards, no gradients, no shadows
inside the slide, and no texture. If a slide needs more, reach for a diagram before
reaching for decoration.
