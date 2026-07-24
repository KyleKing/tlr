import { assert, assertStringIncludes } from "@std/assert"
import { generateSnapshots } from "@/seed.ts"
import { boardSvg, timelineSvg } from "@/export.ts"

function balanced(svg: string): boolean {
  const open = (svg.match(/<svg/g) || []).length
  const close = (svg.match(/<\/svg>/g) || []).length
  return open === 1 && close === 1
}

Deno.test("boardSvg renders the project and a person", () => {
  const { a } = generateSnapshots()
  const svg = boardSvg(a)
  assert(svg.startsWith("<svg"))
  assertStringIncludes(svg, a.project.name)
  assertStringIncludes(svg, "Ada Lovelace")
  assert(balanced(svg))
})

Deno.test("timelineSvg renders a seeded issue id", () => {
  const { a } = generateSnapshots()
  const svg = timelineSvg(a)
  assert(svg.startsWith("<svg"))
  assertStringIncludes(svg, "SEED-101")
  assert(balanced(svg))
})

Deno.test("exports are deterministic across runs", () => {
  const { a, b } = generateSnapshots()
  assert(boardSvg(a) === boardSvg(generateSnapshots().a))
  assert(timelineSvg(b) === timelineSvg(generateSnapshots().b))
})
