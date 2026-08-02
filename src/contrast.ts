// Measures the deck theme's colour tokens against WCAG contrast thresholds. The rule this exists to
// enforce is that changing a background silently invalidates every measured pair on top of it, which
// is not something eyes catch on a laptop and the room catches on a TV.

import { contrastRatio } from "../web/lib/theme.js"

export type Palette = Record<string, string>

export interface Pair {
  role: string
  fg: string
  bg: string
  min?: number
  max?: number
}

/**
 * Every text and stroke pair the theme is allowed to render, with the threshold each must clear.
 * `min` is a floor (4.5 for text, 3 for a graphic stroke); `max` marks a fill-only token, which
 * must stay far enough under the stroke threshold that it can never pass as one.
 */
export const PAIRS: readonly Pair[] = [
  { role: "body and headings", fg: "--rd-ink", bg: "--rd-canvas", min: 4.5 },
  { role: "secondary text", fg: "--rd-ink-2", bg: "--rd-canvas", min: 4.5 },
  { role: "list markers", fg: "--rd-ink-3", bg: "--rd-canvas", min: 3 },
  { role: "ink pen text", fg: "--rd-pen-ink-ink", bg: "--rd-canvas", min: 4.5 },
  { role: "quiet pen text", fg: "--rd-pen-quiet-ink", bg: "--rd-canvas", min: 4.5 },
  { role: "blue pen text", fg: "--rd-pen-blue-ink", bg: "--rd-canvas", min: 4.5 },
  { role: "red pen text", fg: "--rd-pen-red-ink", bg: "--rd-canvas", min: 4.5 },
  { role: "violet pen text", fg: "--rd-pen-violet-ink", bg: "--rd-canvas", min: 4.5 },
  { role: "ink pen stroke", fg: "--rd-pen-ink", bg: "--rd-canvas", min: 3 },
  { role: "quiet pen stroke", fg: "--rd-pen-quiet", bg: "--rd-canvas", min: 3 },
  { role: "blue pen stroke", fg: "--rd-pen-blue", bg: "--rd-canvas", min: 3 },
  { role: "red pen stroke", fg: "--rd-pen-red", bg: "--rd-canvas", min: 3 },
  { role: "violet pen stroke", fg: "--rd-pen-violet", bg: "--rd-canvas", min: 3 },
  { role: "code", fg: "--rd-ink", bg: "--rd-canvas-sunk", min: 4.5 },
  { role: "unfocused code", fg: "--rd-code-dim", bg: "--rd-canvas-sunk", min: 4.5 },
  { role: "highlighted code", fg: "--rd-ink", bg: "--rd-code-focus", min: 4.5 },
  { role: "text on an ink wash", fg: "--rd-ink", bg: "--rd-wash-ink", min: 4.5 },
  { role: "text on a blue wash", fg: "--rd-ink", bg: "--rd-wash-blue", min: 4.5 },
  { role: "text on a red wash", fg: "--rd-ink", bg: "--rd-wash-red", min: 4.5 },
  { role: "text on a violet wash", fg: "--rd-ink", bg: "--rd-wash-violet", min: 4.5 },
  { role: "ink wash is fill-only", fg: "--rd-wash-ink", bg: "--rd-canvas", max: 2.2 },
  { role: "quiet wash is fill-only", fg: "--rd-wash-quiet", bg: "--rd-canvas", max: 2.2 },
  { role: "blue wash is fill-only", fg: "--rd-wash-blue", bg: "--rd-canvas", max: 2.2 },
  { role: "red wash is fill-only", fg: "--rd-wash-red", bg: "--rd-canvas", max: 2.2 },
  { role: "violet wash is fill-only", fg: "--rd-wash-violet", bg: "--rd-canvas", max: 2.2 },
]

function block(css: string, selector: string): string {
  const start = css.indexOf(selector)
  if (start === -1) throw new Error(`no ${selector} block in the token sheet`)
  const open = css.indexOf("{", start)
  const close = css.indexOf("}", open)
  return css.slice(open + 1, close)
}

function declarations(source: string): Palette {
  const palette: Palette = {}
  for (const [, name, value] of source.matchAll(/(--rd-[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    palette[name] = value
  }
  return palette
}

/**
 * The high-contrast palette overrides a subset of the light one, so it inherits everything it does
 * not redeclare. Measuring it standalone would silently skip whatever it left alone.
 */
export function parsePalettes(css: string): { light: Palette; highContrast: Palette } {
  const light = declarations(block(css, ":root"))
  const overrides = declarations(block(css, ":root.rd-hc"))
  return { light, highContrast: { ...light, ...overrides } }
}

export interface Measurement extends Pair {
  ratio: number
  passes: boolean
}

export function measure(palette: Palette, pairs: readonly Pair[] = PAIRS): Measurement[] {
  return pairs.map((pair) => {
    const fg = palette[pair.fg]
    const bg = palette[pair.bg]
    if (!fg || !bg) throw new Error(`missing token in the palette: ${fg ? pair.bg : pair.fg}`)
    const ratio = contrastRatio(fg, bg)
    const passes = (pair.min === undefined || ratio >= pair.min) && (pair.max === undefined || ratio <= pair.max)
    return { ...pair, ratio, passes }
  })
}
