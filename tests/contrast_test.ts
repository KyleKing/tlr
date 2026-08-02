import { assert } from "jsr:@std/assert@1"
import { measure, parsePalettes } from "../src/contrast.ts"

const TOKENS = new URL("../presentations/slidev-theme-roughdraft/styles/tokens.css", import.meta.url)

const { light, highContrast } = parsePalettes(await Deno.readTextFile(TOKENS))

// A deck is delivered on a TV in a lit room, so contrast is a delivery requirement rather than a
// preference. The failure this guards against is indirect: a background moves, and every measured
// pair sitting on it silently drops below AA without anything in the diff looking wrong.
for (const [name, palette] of [["light", light], ["high contrast", highContrast]] as const) {
  Deno.test(`the ${name} deck palette measures as documented`, () => {
    for (const m of measure(palette)) {
      const bound = m.min !== undefined ? `at least ${m.min}:1` : `at most ${m.max}:1`
      assert(m.passes, `${m.role} (${m.fg} on ${m.bg}) is ${m.ratio.toFixed(2)}:1, needs ${bound}`)
    }
  })
}

Deno.test("the high-contrast palette inherits every token it does not override", () => {
  for (const token of Object.keys(light)) {
    assert(highContrast[token], `${token} is missing from the high-contrast palette`)
  }
})
