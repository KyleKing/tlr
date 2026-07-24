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
    subtext0: "#6c6f85",
    surface1: "#bcc0cc",
    surface0: "#ccd0da",
    mauve: "#8839ef",
    red: "#d20f39",
    peach: "#fe640b",
    yellow: "#df8e1d",
    green: "#40a02b",
    teal: "#179299",
    sky: "#04a5e5",
    blue: "#1e66f5",
    pink: "#ea76cb",
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

// { "--base": "#1e1e2e", ..., "--accent": "<accent hex>" } for setting as CSS custom properties.
export function themeVars(flavor, accent) {
  const p = PALETTE[flavor]
  /** @type {Record<string, string>} */
  const vars = {}
  for (const [k, v] of Object.entries(p)) vars[`--${k}`] = v
  vars["--accent"] = p[accent]
  return vars
}

// "mocha" if the OS prefers dark, "latte" otherwise — Catppuccin's own light/dark split.
export function defaultFlavor(prefersDark) {
  return prefersDark ? "mocha" : "latte"
}
