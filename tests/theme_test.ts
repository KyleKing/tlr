import { assertEquals } from "jsr:@std/assert@1"
import { ACCENTS, defaultFlavor, FLAVORS, PALETTE, themeVars } from "../web/lib/theme.js"

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
