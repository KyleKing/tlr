// Catppuccin palette (https://catppuccin.com/palette) as the board's color source. Four flavors, a
// curated set of accents; status colors (green/blue/peach/mauve/red) are fixed per flavor and are not
// user-selectable, only the interactive --accent is.

export const FLAVORS = ["latte", "frappe", "macchiato", "mocha"]
export const ACCENTS = ["mauve", "blue", "green", "peach", "pink", "teal", "lavender", "yellow"]

/** @type {Record<string, Record<string, string>>} */
export const PALETTE = {
  latte: {
    base: "#eff1f5",
    mantle: "#e6e9ef",
    crust: "#dce0e8",
    text: "#4c4f69",
    // Darkened from stock Catppuccin (#6c6f85, 4.36:1 on --base) to clear WCAG AA 4.5:1 on --mantle too.
    subtext0: "#65687a",
    surface1: "#bcc0cc",
    surface0: "#ccd0da",
    // Darkened from stock Catppuccin (#8839ef) so bold nav-link text clears 4.5:1 on --mantle (was 4.45:1).
    mauve: "#8035e0",
    // Every color below this line is darkened from stock Catppuccin Latte. These double as small
    // status/flag text (10-11px) on --base/--mantle, and Latte's own accents are pastel — tuned for
    // icons and fills, not body text — so most failed WCAG AA 4.5:1 (as low as 2.15:1). Darkened only
    // enough to clear it; still used as pill/badge fill backgrounds elsewhere, which stays legible
    // regardless via a computed contrasting foreground (see --*-fg in themeVars).
    red: "#cd0e37",
    peach: "#b14607",
    yellow: "#905c12",
    green: "#2f761f",
    teal: "#179299",
    sky: "#04a5e5",
    blue: "#1b5de1",
    pink: "#984c83",
    lavender: "#7287fd",
  },
  frappe: {
    base: "#303446",
    mantle: "#292c3c",
    crust: "#232634",
    text: "#c6d0f5",
    subtext0: "#a5adce",
    surface1: "#51576d",
    surface0: "#414559",
    mauve: "#ca9ee6",
    red: "#e78284",
    peach: "#ef9f76",
    yellow: "#e5c890",
    green: "#a6d189",
    teal: "#81c8be",
    sky: "#99d1db",
    blue: "#8caaee",
    pink: "#f4b8e4",
    lavender: "#babbf1",
  },
  macchiato: {
    base: "#24273a",
    mantle: "#1e2030",
    crust: "#181926",
    text: "#cad3f5",
    subtext0: "#a5adcb",
    surface1: "#494d64",
    surface0: "#363a4f",
    mauve: "#c6a0f6",
    red: "#ed8796",
    peach: "#f5a97f",
    yellow: "#eed49f",
    green: "#a6da95",
    teal: "#8bd5ca",
    sky: "#91d7e3",
    blue: "#8aadf4",
    pink: "#f5bde6",
    lavender: "#b7bdf8",
  },
  mocha: {
    base: "#1e1e2e",
    mantle: "#181825",
    crust: "#11111b",
    text: "#cdd6f4",
    subtext0: "#a6adc8",
    surface1: "#45475a",
    surface0: "#313244",
    mauve: "#cba6f7",
    red: "#f38ba8",
    peach: "#fab387",
    yellow: "#f9e2af",
    green: "#a6e3a1",
    teal: "#94e2d5",
    sky: "#89dceb",
    blue: "#89b4fa",
    pink: "#f5c2e7",
    lavender: "#b4befe",
  },
}

// Status/flag semantic colors, mapped from each flavor's fixed palette (not user-selectable).
const SEMANTIC = {
  "st-started": "blue",
  "st-unstarted": "subtext0",
  "st-triage": "yellow",
  "st-backlog": "surface1",
  "st-completed": "green",
  "st-canceled": "red",
  risk: "peach",
  slop: "pink",
  miss: "red",
}

// Relative luminance (WCAG) of a "#rrggbb" hex color, 0 (black) to 1 (white).
export function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

// WCAG contrast ratio between two "#rrggbb" colors, 1 (no contrast) to 21 (black on white). Exported
// so theme_test.ts can assert every flavor/accent combination clears AA (4.5:1) wherever this module's
// colors end up as small text — the bug class this guards is a text color picked without checking it
// against the background it will actually render on, which this repo has hit more than once.
export function contrastRatio(hexA, hexB) {
  const a = luminance(hexA)
  const b = luminance(hexB)
  const lighter = Math.max(a, b)
  const darker = Math.min(a, b)
  return (lighter + 0.05) / (darker + 0.05)
}

// The near-black/near-white text color that contrasts better against a given background — picking by
// a luminance > 0.5 midpoint (this module's first pass) is wrong, since contrast-vs-black and
// contrast-vs-white cross at luminance ≈ 0.179, not 0.5; anything between those darkened comfortably
// enough to look "light" still contrasted better with black than white and got the wrong pick.
function contrastFg(hex) {
  return contrastRatio(hex, "#111111") >= contrastRatio(hex, "#f5f5f5") ? "#111111" : "#f5f5f5"
}

// { "--base": "#1e1e2e", ..., "--accent": "<accent hex>" } for setting as CSS custom properties.
export function themeVars(flavor, accent) {
  const p = PALETTE[flavor]
  /** @type {Record<string, string>} */
  const vars = {}
  for (const [k, v] of Object.entries(p)) vars[`--${k}`] = v
  vars["--accent"] = p[accent]
  // Text drawn on a solid --accent background (filled buttons, selected pills): pick whichever
  // extreme contrasts with the chosen accent, since accents range from dark (mauve) to pastel
  // (yellow, pink) across flavors and a fixed --base/--text pairing goes unreadable on the light ones.
  vars["--accent-fg"] = contrastFg(p[accent])
  for (const [k, source] of Object.entries(SEMANTIC)) {
    const color = p[source] ?? p.red
    vars[`--${k}`] = color
    vars[`--${k}-fg`] = contrastFg(color)
  }
  return vars
}

// "mocha" if the OS prefers dark, "latte" otherwise — Catppuccin's own light/dark split.
export function defaultFlavor(prefersDark) {
  return prefersDark ? "mocha" : "latte"
}
