// Writes the deterministic synthetic snapshots to web/data so the board, the CLI, and the Phase 1
// diff/review path all have real-looking data without a Linear workspace. Emits seed-a.json (earlier)
// and seed-b.json (a week later, with drift), and registers the seeded project in projects.json so
// `deno task dev` can show it. Everything lands under web/data, which is gitignored.
//
// The owner has no Linear key wired here, so this is the offline generator. A future `--linear` mode
// would push the same synthetic data into a free workspace through the tracker port (see ROADMAP.md).

import { generateSnapshots, type Snapshot } from "../src/seed.ts"

const DATA_ROOT = new URL("../web/data/", import.meta.url)

type ProjectEntry = { slug: string; name: string; dataFile: string }

async function upsertProject(entry: ProjectEntry): Promise<void> {
  const path = new URL("projects.json", DATA_ROOT)
  const existing: ProjectEntry[] = await Deno.readTextFile(path).then(JSON.parse).catch(() => [])
  const kept = existing.filter((p) => p.slug !== entry.slug)
  kept.push(entry)
  kept.sort((x, y) => x.name.localeCompare(y.name))
  await Deno.writeTextFile(path, JSON.stringify(kept, null, 2) + "\n")
}

async function writeSnapshot(name: string, snapshot: Snapshot): Promise<void> {
  await Deno.mkdir(DATA_ROOT, { recursive: true })
  await Deno.writeTextFile(new URL(name, DATA_ROOT), JSON.stringify(snapshot, null, 2) + "\n")
}

if (import.meta.main) {
  const { a, b } = generateSnapshots()
  await writeSnapshot("seed-a.json", a)
  await writeSnapshot("seed-b.json", b)
  await upsertProject({ slug: "seeded-reliability", name: b.project.name, dataFile: "seed-b.json" })
  console.log("wrote web/data/seed-a.json and web/data/seed-b.json")
  console.log(`registered project "${b.project.name}" (seed-b.json) in projects.json`)
  console.log("view it with: deno task dev  then open ?project=seeded-reliability")
}
