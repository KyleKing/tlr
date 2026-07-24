import { assert, assertEquals } from "jsr:@std/assert@1"
import { ACCENTS, contrastRatio, defaultFlavor, FLAVORS, PALETTE, themeVars } from "../web/lib/theme.js"

const AA = 4.5

// The raw palette colors used as small (10-11px) text somewhere in the app (status labels, the slop/
// risk/miss summary counts, the bold current-page nav link) rather than only as a fill. A color here
// that fails against --base or --mantle in any flavor is the exact bug class that shipped twice before
// (Latte's pastel accents read fine as fills but not as text; the "Open in Linear" link overrode only
// its text color on top of a solid accent fill, landing on light-on-light for some accent choices).
const TEXT_COLORS = ["mauve", "red", "peach", "yellow", "green", "blue", "pink", "text", "subtext0"]

Deno.test("every flavor's text-usable colors clear WCAG AA against --base and --mantle", () => {
  for (const flavor of FLAVORS) {
    const p = PALETTE[flavor]
    for (const name of TEXT_COLORS) {
      for (const bg of ["base", "mantle"]) {
        const ratio = contrastRatio(p[bg], p[name])
        assert(
          ratio >= AA,
          `${flavor}.${name} on --${bg} is only ${ratio.toFixed(2)}:1 (need ${AA}:1)`,
        )
      }
    }
  }
})

Deno.test("every flavor/accent combination's computed --accent-fg clears WCAG AA on --accent", () => {
  for (const flavor of FLAVORS) {
    for (const accent of ACCENTS) {
      const vars = themeVars(flavor, accent)
      const ratio = contrastRatio(vars["--accent"], vars["--accent-fg"])
      assert(ratio >= AA, `${flavor}/${accent}: --accent-fg on --accent is only ${ratio.toFixed(2)}:1`)
    }
  }
})

Deno.test("every flavor's computed status/flag -fg colors clear WCAG AA on their own fill", () => {
  for (const flavor of FLAVORS) {
    const vars = themeVars(flavor, ACCENTS[0])
    for (const key of Object.keys(vars)) {
      if (!key.endsWith("-fg") || key === "--accent-fg") continue
      const base = key.slice(0, -3)
      const ratio = contrastRatio(vars[base], vars[key])
      assert(ratio >= AA, `${flavor}: ${key} on ${base} is only ${ratio.toFixed(2)}:1`)
    }
  }
})

Deno.test("every flavor defines every accent and base token", () => {
  const baseTokens = ["base", "mantle", "crust", "text", "subtext0", "surface1", "surface0"]
  for (const flavor of FLAVORS) {
    for (const token of baseTokens) assertEquals(typeof PALETTE[flavor][token], "string")
    for (const accent of ACCENTS) assertEquals(typeof PALETTE[flavor][accent], "string")
  }
})

Deno.test("themeVars maps every base token plus the chosen accent", () => {
  const vars = themeVars("mocha", "blue")
  assertEquals(vars["--base"], "#1e1e2e")
  assertEquals(vars["--accent"], "#89b4fa")
})

Deno.test("defaultFlavor follows the OS dark-mode preference", () => {
  assertEquals(defaultFlavor(true), "mocha")
  assertEquals(defaultFlavor(false), "latte")
})
