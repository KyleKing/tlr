import { liveIssues } from "../../web/lib/issues.js"
import { slopHash, slopScan } from "../../web/lib/planning.js"
import type { Issue, Snapshot } from "@/seed.ts"

export function scanText(text: string) {
  const { score, flags } = slopScan(text)
  return { score, flags, hash: slopHash(text) }
}

export function scanIssues(snapshot: Snapshot) {
  const scored = (liveIssues(snapshot.issues) as Issue[]).map((i) => {
    const { score, flags } = slopScan(i.description)
    return { id: i.id, title: i.title, score, flags }
  })
  const flagged = scored.filter((s) => s.score >= 2).sort((a, b) => b.score - a.score)
  const total = scored.length
  const sum = scored.reduce((acc, s) => acc + s.score, 0)
  const avgScore = total ? Math.round((sum / total) * 100) / 100 : 0
  return {
    total,
    flagged,
    summary: { flaggedCount: flagged.length, avgScore },
  }
}
