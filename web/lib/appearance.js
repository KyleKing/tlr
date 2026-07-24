// Shared theme load/apply, so every page renders the flavor and accent chosen on the Settings page.
// The palette math lives in theme.js; this adds the localStorage persistence and the DOM write. The
// Settings page owns the pickers that mutate the theme; other pages only load and apply it.

import { defaultFlavor, themeVars } from "./theme.js"

const THEME_KEY = "tlr.theme"

export function loadTheme() {
  const saved = JSON.parse(localStorage.getItem(THEME_KEY) || "null")
  return {
    flavor: saved?.flavor ?? defaultFlavor(matchMedia("(prefers-color-scheme: dark)").matches),
    accent: saved?.accent ?? "mauve",
  }
}

export function applyTheme(theme) {
  const root = document.documentElement
  for (const [k, v] of Object.entries(themeVars(theme.flavor, theme.accent))) root.style.setProperty(k, v)
  localStorage.setItem(THEME_KEY, JSON.stringify(theme))
}
