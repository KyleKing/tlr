import { assertEquals } from "@std/assert"
import { parseFlags, run } from "./cli.ts"

const RECORDS = [
  {
    source: "fixture",
    id: "1",
    url: "https://example.test/1",
    title: "Export times out",
    body: "linked by the source itself",
    createdAt: "2026-08-01T00:00:00Z",
    links: ["linear:DEV-1"],
  },
  {
    source: "fixture",
    id: "2",
    url: "https://example.test/2",
    title: "Slow export",
    body: "same week, unlinked",
    createdAt: "2026-08-03T00:00:00Z",
  },
]

async function cli(args: string[]): Promise<string> {
  const lines: string[] = []
  const log = console.log
  console.log = (value: unknown) => void lines.push(String(value))
  try {
    await run(args[0], parseFlags(args.slice(1)))
  } finally {
    console.log = log
  }
  return lines.join("\n")
}

async function withFixture(fn: (path: string) => Promise<void>): Promise<void> {
  const path = await Deno.makeTempFile({ suffix: ".json" })
  await Deno.writeTextFile(path, JSON.stringify(RECORDS))
  try {
    await fn(path)
  } finally {
    await Deno.remove(path)
  }
}

Deno.test("context prints a linked hit and skips the wider net", async () => {
  await withFixture(async (path) => {
    const output = await cli([
      "context",
      "--issue",
      "DEV-1",
      "--created",
      "2026-08-02T00:00:00Z",
      "--fixture",
      path,
      "--no-cache",
    ])
    const result = JSON.parse(output)
    assertEquals(result.issue, "DEV-1")
    assertEquals(result.tracker, "linear")
    assertEquals(result.linked, 1)
    assertEquals(result.candidates, 0)
    assertEquals(result.items.map((i: { id: string }) => i.id), ["1"])
    assertEquals(result.errors, [])
  })
})

Deno.test("context widens to the window when nothing is linked, linked ordering first", async () => {
  await withFixture(async (path) => {
    const output = await cli([
      "context",
      "--issue",
      "DEV-404",
      "--created",
      "2026-08-02T00:00:00Z",
      "--days",
      "3",
      "--fixture",
      path,
      "--no-cache",
    ])
    const result = JSON.parse(output)
    assertEquals(result.linked, 0)
    assertEquals(result.candidates, 2)
    assertEquals(result.items.map((i: { matchKind: string }) => i.matchKind), ["candidate", "candidate"])
    assertEquals(result.items.map((i: { id: string }) => i.id), ["2", "1"])
    assertEquals(result.window.start, "2026-07-30T00:00:00.000Z")
  })
})
