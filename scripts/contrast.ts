// Prints the deck theme's measured contrast table. Run it when picking a new colour, and after any
// change to a background: tests/contrast_test.ts fails on a regression, this shows the margin.

import { measure, parsePalettes } from "../src/contrast.ts"

const TOKENS = new URL("../presentations/slidev-theme-roughdraft/styles/tokens.css", import.meta.url)

if (import.meta.main) {
  const { light, highContrast } = parsePalettes(await Deno.readTextFile(TOKENS))
  let failed = false
  for (const [name, palette] of [["light", light], ["high contrast", highContrast]] as const) {
    console.log(`\n${name}`)
    for (const m of measure(palette)) {
      const bound = m.min !== undefined ? `min ${m.min}` : `max ${m.max}`
      console.log(`  ${m.passes ? " " : "!"} ${m.ratio.toFixed(2).padStart(6)}:1  ${bound.padEnd(8)}  ${m.role}`)
      failed ||= !m.passes
    }
  }
  if (failed) Deno.exit(1)
}
