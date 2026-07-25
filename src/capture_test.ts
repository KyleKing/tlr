import { assertEquals, assertStringIncludes } from "@std/assert"
import { COLLAPSE_FLOOR, collapseMessage, isImplausibleDrop } from "@/capture.ts"

Deno.test("isImplausibleDrop leaves small projects alone", () => {
  assertEquals(isImplausibleDrop(COLLAPSE_FLOOR - 1, 0), false)
  assertEquals(isImplausibleDrop(6, 1), false)
  assertEquals(isImplausibleDrop(0, 0), false)
})

Deno.test("isImplausibleDrop fires only past half of a project big enough to judge", () => {
  assertEquals(isImplausibleDrop(80, 39), true)
  assertEquals(isImplausibleDrop(80, 40), false)
  assertEquals(isImplausibleDrop(80, 41), false)
  assertEquals(isImplausibleDrop(10, 4), true)
  assertEquals(isImplausibleDrop(10, 5), false)
})

Deno.test("isImplausibleDrop ignores growth and a steady count", () => {
  assertEquals(isImplausibleDrop(40, 40), false)
  assertEquals(isImplausibleDrop(40, 90), false)
})

Deno.test("isImplausibleDrop takes an explicit floor and ratio", () => {
  assertEquals(isImplausibleDrop(20, 17, 5, 0.1), true)
  assertEquals(isImplausibleDrop(20, 19, 5, 0.1), false)
})

Deno.test("collapseMessage names the counts and the override", () => {
  const message = collapseMessage("Product Reliability 2026", 77, 3)
  assertStringIncludes(message, "77")
  assertStringIncludes(message, "3")
  assertStringIncludes(message, "--allow-collapse")
})
