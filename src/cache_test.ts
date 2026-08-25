import { assert, assertEquals } from "@std/assert"
import { fingerprint, openCache } from "@/cache.ts"

const HOUR = 60 * 60 * 1000

Deno.test("two queries against one source keep separate entries", () => {
  const cache = openCache(null)
  cache.set("pylon", { linkedId: "DEV-1" }, [{ id: "a" }])
  cache.set("pylon", { linkedId: "DEV-2" }, [{ id: "b" }])
  assertEquals(cache.get("pylon", { linkedId: "DEV-1" }, HOUR), [{ id: "a" }])
  assertEquals(cache.get("pylon", { linkedId: "DEV-2" }, HOUR), [{ id: "b" }])
  assertEquals(cache.get("slack", { linkedId: "DEV-1" }, HOUR), null)
  cache.close()
})

Deno.test("fingerprint ignores key order and undefined fields", () => {
  assertEquals(fingerprint({ b: 2, a: 1 }), fingerprint({ a: 1, b: 2 }))
  assertEquals(fingerprint({ a: 1, limit: undefined }), fingerprint({ a: 1 }))
  assert(fingerprint({ a: 1 }) !== fingerprint({ a: 2 }))
})

Deno.test("an entry past its ttl reads as a miss and prunes", () => {
  const cache = openCache(null)
  cache.set("pylon", { text: "q" }, ["hit"], Date.now() - 2 * HOUR)
  assertEquals(cache.get("pylon", { text: "q" }, HOUR), null)
  assertEquals(cache.get("pylon", { text: "q" }, 3 * HOUR), ["hit"])
  assertEquals(cache.prune(HOUR), 1)
  assertEquals(cache.get("pylon", { text: "q" }, 3 * HOUR), null)
  cache.close()
})

Deno.test("entries survive reopening a file-backed cache", () => {
  const path = Deno.makeTempFileSync({ suffix: ".sqlite" })
  const first = openCache(path)
  first.set("pylon", { text: "q" }, { ok: true })
  first.close()
  const second = openCache(path)
  assertEquals(second.get("pylon", { text: "q" }, HOUR), { ok: true })
  second.close()
  Deno.removeSync(path)
})
